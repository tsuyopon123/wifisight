// Survey mode: floor plan + measured points → per SSID / AP / BSSID heatmap.

import * as api from "./api";
import {
  FLOOR_DBM,
  apKey,
  coChannel,
  estimatePos,
  idwGrid,
  layerValue,
  median,
  niceLength,
  secondBest,
  snrAt,
  type Radio,
  type Sample,
} from "./heatmap";
import type { BssInfo, Snapshot } from "./types";
import { colorFor, esc, keepFocus, signalColor, ssidLabel } from "./util";

interface SurveyPoint {
  id: string;
  x: number; // 0..1 of image width
  y: number; // 0..1 of image height
  t: number;
  scans: number;
  rssi: Record<string, number>;
  noise?: Record<string, number>; // only where the OS reports noise
}

interface SurveyProject {
  app: "wifisight";
  kind: "survey";
  version: 1;
  name: string;
  image: string; // data URL
  imageW: number;
  imageH: number;
  bss: Record<string, BssInfo>;
  points: SurveyPoint[];
  apPos?: Record<string, { x: number; y: number }>; // AP key → placed position (0..1), overrides the estimate
  mPerPx?: number; // metres per image pixel
  opacity?: number; // heatmap 0..1
  planGray?: boolean; // floor plan in black & white
  planTone?: number; // -100 (darker: more contrast) .. 100 (lighter: faded to white)
  maskFrac?: number; // coverage radius, fraction of the plan diagonal
}

export interface SurveyHost {
  /** BSS passes the current band toggles / filter text. */
  visible(b: BssInfo): boolean;
  /** Make sure the scan loop is running; returns true if a scan is currently in flight. */
  ensureRunning(): boolean;
  /** Scan loop running (not paused)? */
  running(): boolean;
  /** Scan interval (ms), for the time-per-point estimate. */
  intervalMs(): number;
  status(msg: string): void;
}

interface ApGroup {
  key: string;
  label: string;
  bssids: string[];
  ssids: string[];
  channels: number[];
  bands: string[];
  widths: number[];
  vendor: string;
  best: number;
  heard: number;
  pos: { x: number; y: number } | null; // image 0..1
}

// AP list columns: sortable, toggleable (persisted per machine). The ↺ action column is always shown.
const AP_COLS: { key: string; label: string; num?: boolean; title?: string; sort: (g: ApGroup) => number | string; html: (g: ApGroup) => string }[] = [
  { key: "ap", label: "AP", sort: (g) => g.label.toLowerCase(), html: (g) => `<span class="swatch" style="background:${colorFor(g.key)}"></span>${esc(g.label)}` },
  { key: "ssid", label: "SSID", sort: (g) => g.ssids.join(", ").toLowerCase(), html: (g) => esc(g.ssids.join(", ")) },
  { key: "vendor", label: "Vendor", sort: (g) => g.vendor.toLowerCase(), html: (g) => esc(g.vendor) },
  { key: "band", label: "Band", num: true, sort: (g) => g.bands.join(","), html: (g) => esc(g.bands.join(",")) },
  { key: "ch", label: "Ch", num: true, sort: (g) => g.channels[0], html: (g) => esc(g.channels.join(",")) },
  { key: "width", label: "Width", num: true, title: "Channel width (MHz)", sort: (g) => Math.max(...g.widths), html: (g) => esc(g.widths.join(",")) },
  { key: "best", label: "Best", num: true, title: "Strongest RSSI (dBm)", sort: (g) => g.best, html: (g) => `<i class="lvl" style="background:${signalColor(g.best)}"></i>${g.best}` },
  { key: "pts", label: "Pts", num: true, title: "Points that heard this AP", sort: (g) => g.heard, html: (g) => String(g.heard) },
  { key: "bss", label: "BSS", num: true, title: "Number of BSSIDs", sort: (g) => g.bssids.length, html: (g) => String(g.bssids.length) },
  { key: "pos", label: "Pos", title: "◆ placed / ✕ estimated", sort: (g) => (project?.apPos?.[g.key] ? 1 : 0), html: (g) => (project?.apPos?.[g.key] ? "◆" : "✕") },
];
const AP_VIEW_KEY = "wifisight.svAps";
let apView: { hidden: string[]; sort: string; asc: boolean } = { hidden: ["vendor", "band", "width", "bss", "pos"], sort: "best", asc: false };

function saveApView() {
  try {
    localStorage.setItem(AP_VIEW_KEY, JSON.stringify(apView));
  } catch {
    /* storage unavailable */
  }
}

type Metric = "signal" | "second" | "snr" | "cci";

// steps = class boundaries good → bad; `higher` = bigger is better
const METRICS: Record<Metric, { label: string; unit: string; steps: number[]; higher: boolean; dbm: boolean; legend: string[] }> = {
  signal: { label: "Signal", unit: "dBm", steps: [-60, -67, -75, -82], higher: true, dbm: true, legend: ["≥-60", "≥-67", "≥-75", "≥-82", "<-82"] },
  second: { label: "2nd AP signal", unit: "dBm", steps: [-60, -67, -75, -82], higher: true, dbm: true, legend: ["≥-60", "≥-67", "≥-75", "≥-82", "<-82"] },
  snr: { label: "SNR", unit: "dB", steps: [25, 20, 15, 10], higher: true, dbm: false, legend: ["≥25", "≥20", "≥15", "≥10", "<10"] },
  cci: { label: "Co-channel APs", unit: "APs", steps: [0.5, 1.5, 2.5, 3.5], higher: false, dbm: false, legend: ["0", "1", "2", "3", "4+"] },
};
const CLASS_VARS = ["--good", "--ok", "--fair", "--poor", "--bad"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const CELL_PX = 6;
const DEFAULT_MASK = 0.15;
const DEFAULT_OPACITY = 0.47;
const NO_COVERAGE_DBM = -88;
// ponytail: fixed co-channel threshold (≈ preamble detect); make it a setting if designs differ.
const CCI_DBM = -82;
const MAX_ZOOM = 16;
// marks are small on the plan; the pointer target is bigger so a trackpad tap while walking still lands
const POINT_R = 7;
const HIT_R = 16;
// consecutive failed scans before a point gives up and waits for Retry
const MAX_FAILS = 3;
// long enough to reach the trackpad with the laptop on one arm
const TOAST_MS = 10000;
// ponytail: export capped at 4000 px on the long side; raise if plans need more detail.
const EXPORT_MAX = 4000;

let host: SurveyHost;
let project: SurveyProject | null = null;
let img: HTMLImageElement | null = null;
let layer = "best";
let metric: Metric = "signal";
let selectedPoint: string | null = null;
let scansPerPoint = 1;
let instant = true; // record the latest scan right away instead of waiting for new ones
let lastSnap: Snapshot | null = null;
let measuring: {
  id: string;
  isNew: boolean; // cancel removes a point that was never measured
  left: number;
  skip: number;
  fails: number;
  err: string;
  samples: Record<string, number[]>;
  noise: Record<string, number[]>;
} | null = null;
// a point whose measurement gave up after MAX_FAILS failed scans
let stalled: { id: string; msg: string } | null = null;
// ponytail: undo is in memory only (lost on restart); the autosave covers crashes
let undos: { label: string; undo: () => void }[] = [];
let toastTimer: number | undefined;
let savedAt = 0;
let saveErr = "";
let active = false;
// scale calibration: first point picked, then both → waiting for the distance
let calib: { a?: { x: number; y: number }; b?: { x: number; y: number } } | null = null;
let audio: AudioContext | null = null;

const canvas = () => $<HTMLCanvasElement>("sv-canvas");
// image rect on the canvas, in CSS px
let view = { x: 0, y: 0, w: 0, h: 0 };
let markers: { x: number; y: number; group: ApGroup }[] = [];
// zoom 1 = fit; pan = offset of the image centre from the canvas centre, CSS px
let zoom = 1;
let pan = { x: 0, y: 0 };
// hand tool: every drag pans, clicks don't add / select points (also: middle-button drag)
let hand = false;
// blurred heatmap at base size; rebuilt only when its inputs change
let heat: { key: string; canvas: HTMLCanvasElement } | null = null;

// ───────────────────────── data ─────────────────────────

function strip(b: BssInfo): BssInfo {
  return { ...b, ies: [], vendorIes: [] };
}

function visibleBssids(): string[] {
  if (!project) return [];
  return Object.values(project.bss)
    .filter((b) => host.visible(b))
    .map((b) => b.bssid);
}

function layerBssids(): string[] {
  const vis = visibleBssids();
  if (!project || layer === "best") return vis;
  const [kind, ...rest] = layer.split(":");
  const v = rest.join(":");
  const bss = project.bss;
  if (kind === "ssid") return vis.filter((b) => ssidLabel(bss[b]) === v);
  if (kind === "bssid") return vis.filter((b) => b === v);
  return vis.filter((b) => apKey(b, bss[b].apName) === v); // "ap:<key>"
}

function layerLabel(): string {
  if (!project || layer === "best") return "all visible";
  const [kind, ...rest] = layer.split(":");
  const v = rest.join(":");
  if (kind !== "ap") return `${kind.toUpperCase()} ${v}`;
  const b = Object.values(project.bss).find((x) => apKey(x.bssid, x.apName) === v);
  return `AP ${b?.apName ?? v}`;
}

function samplesFor(bssids: string[]): Sample[] {
  return (project?.points ?? [])
    .filter((p) => p.scans > 0)
    .map((p) => ({ x: p.x, y: p.y, v: layerValue(p.rssi, bssids) }));
}

/** Metric value at one point; null = no data (grey dot, left out of the heatmap). */
function pointValue(p: SurveyPoint, bssids: string[], radios: Record<string, Radio>): number | null {
  if (!project || !p.scans) return null;
  const bss = project.bss;
  if (metric === "signal") return layerValue(p.rssi, bssids);
  if (metric === "second") return secondBest(p.rssi, bssids, (b) => apKey(b, bss[b].apName));
  if (metric === "snr") return snrAt(p.rssi, p.noise, bssids);
  return coChannel(p.rssi, bssids, radios, CCI_DBM);
}

function radiosOf(): Record<string, Radio> {
  return Object.fromEntries(Object.values(project?.bss ?? {}).map((b) => [b.bssid, { ap: apKey(b.bssid, b.apName), lo: b.freqLowMhz, hi: b.freqHighMhz }]));
}

const noData = (v: number | null): v is null => v == null || (METRICS[metric].dbm && v <= FLOOR_DBM);

function apGroups(bssids: string[]): ApGroup[] {
  if (!project) return [];
  const bss = project.bss;
  const byKey = new Map<string, string[]>();
  for (const b of bssids) {
    const k = apKey(b, bss[b].apName);
    byKey.set(k, [...(byKey.get(k) ?? []), b]);
  }
  return [...byKey.entries()]
    .map(([key, list]) => {
      const s = samplesFor(list);
      const heard = s.filter((x) => x.v > FLOOR_DBM);
      const info = bss[list[0]];
      return {
        key,
        label: info.apName ?? info.bssid.slice(0, 16) + "x",
        bssids: list,
        ssids: [...new Set(list.map((b) => ssidLabel(bss[b])))],
        channels: [...new Set(list.map((b) => bss[b].channel))].sort((a, b) => a - b),
        bands: [...new Set(list.map((b) => bss[b].band))].sort(),
        widths: [...new Set(list.map((b) => bss[b].widthMhz))].sort((a, b) => a - b),
        vendor: info.vendor ?? "",
        best: Math.max(FLOOR_DBM, ...heard.map((x) => x.v)),
        heard: heard.length,
        pos: estimatePos(s),
      };
    })
    .filter((g) => g.heard > 0)
    .sort((a, b) => b.best - a.best);
}

async function autosave() {
  if (!project) return;
  try {
    await api.autosaveWrite(JSON.stringify(project));
    savedAt = Date.now();
    saveErr = "";
  } catch (e) {
    saveErr = String(e);
    host.status(`Survey autosave failed: ${e}. Use Save… to keep your data.`);
  }
  renderSaved();
}

function renderSaved() {
  const el = $("sv-saved");
  el.classList.toggle("err", !!saveErr);
  el.title = saveErr;
  el.textContent = !project ? "" : saveErr ? "Autosave failed — use Save… to keep your data" : savedAt ? `Autosaved ${new Date(savedAt).toLocaleTimeString()}` : "";
}

// ───────────────────────── undo ─────────────────────────

/** Record an undoable change and offer Undo in a toast. */
function pushUndo(label: string, undo: () => void) {
  undos.push({ label, undo });
  if (undos.length > 50) undos.shift();
  showToast(label);
}

function undoLast() {
  const u = undos.pop();
  hideToast();
  if (!u) return;
  u.undo();
  autosave();
  render();
  host.status(`Undone: ${u.label}`);
}

function showToast(label: string) {
  const el = $("sv-toast");
  el.innerHTML = `<span>${esc(label)}</span><button data-undo title="Undo (⌘Z / Ctrl+Z)">Undo</button>`;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  window.clearTimeout(toastTimer);
  $("sv-toast").hidden = true;
}

function loadProject(p: SurveyProject) {
  project = p;
  measuring = null;
  stalled = null;
  undos = [];
  hideToast();
  selectedPoint = null;
  calib = null;
  layer = "best";
  zoom = 1;
  pan = { x: 0, y: 0 };
  heat = null;
  img = new Image();
  img.onload = () => render();
  img.src = p.image;
}

/** Ask before a new / opened survey replaces one that has points. */
async function confirmReplace(what: string): Promise<boolean> {
  const n = project?.points.length ?? 0;
  if (!n) return true;
  return api.ask(`${what}? It replaces “${project!.name}” and its ${n} point${n === 1 ? "" : "s"} (also in the autosave). Save… first to keep a copy; you can also Undo right after.`);
}

/** Swap in another survey, keeping the old one one Undo away. */
function replaceProject(next: SurveyProject) {
  const prev = project;
  loadProject(next);
  if (prev?.points.length) pushUndo(`Replaced “${prev.name}”`, () => loadProject(prev));
  autosave();
}

function parseProject(text: string): SurveyProject {
  const p = JSON.parse(text) as SurveyProject;
  if (p?.kind !== "survey" || !p.image || !Array.isArray(p.points)) throw new Error("not a WiFiSight survey file");
  return p;
}

// ───────────────────────── measurement ─────────────────────────

function beep() {
  if (!audio || !$<HTMLInputElement>("sv-beep").checked) return;
  const t0 = audio.currentTime;
  [880, 1320].forEach((f, i) => {
    const o = audio!.createOscillator(),
      g = audio!.createGain();
    const t = t0 + i * 0.15;
    o.frequency.value = f;
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(audio!.destination);
    o.start(t);
    o.stop(t + 0.12);
  });
}

/** Fed every scan result from main.ts. */
export function onSnapshot(s: Snapshot) {
  lastSnap = s;
  if (!project || !measuring) return;
  if (measuring.skip > 0) {
    measuring.skip--; // scan started before the user got to the spot
    return render();
  }
  measuring.fails = 0;
  measuring.err = "";
  for (const b of s.bss) {
    project.bss[b.bssid] = strip(b);
    (measuring.samples[b.bssid] ??= []).push(b.rssiDbm);
    if (b.noiseDbm != null) (measuring.noise[b.bssid] ??= []).push(b.noiseDbm);
  }
  measuring.left--;
  const pt = project.points.find((p) => p.id === measuring!.id);
  if (measuring.left > 0 || !pt) return;
  const medians = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, median(v)]));
  pt.rssi = medians(measuring.samples);
  pt.noise = Object.keys(measuring.noise).length ? medians(measuring.noise) : undefined;
  pt.scans = scansPerPoint;
  pt.t = s.timestampMs;
  measuring = null;
  host.status(`Point ${project.points.indexOf(pt) + 1}: ${Object.keys(pt.rssi).length} BSS`);
  beep();
  autosave();
  render();
}

/** Fed every failed scan from main.ts: counts toward giving up on the point being measured. */
export function onScanError(msg: string) {
  if (!project || !measuring) return;
  if (measuring.skip > 0) {
    measuring.skip--;
    return render();
  }
  measuring.fails++;
  measuring.err = msg;
  if (measuring.fails >= MAX_FAILS) {
    stalled = { id: measuring.id, msg };
    measuring = null;
    host.status(`Point not measured: ${msg}`);
  }
  render();
}

function measure(pt: SurveyPoint, isNew = false) {
  // created / resumed inside the click so WebKit allows playback later
  audio ??= new AudioContext();
  audio.resume();
  const inFlight = host.ensureRunning();
  measuring = { id: pt.id, isNew, left: scansPerPoint, skip: inFlight ? 1 : 0, fails: 0, err: "", samples: {}, noise: {} };
  stalled = null;
  selectedPoint = pt.id;
  if (instant && lastSnap) {
    measuring.skip = 0;
    return onSnapshot(lastSnap);
  }
  render();
}

/** Stop measuring. A point that never got a result is removed; a re-measured one keeps its old values. */
function cancelMeasure() {
  if (!project || !measuring) return;
  const m = measuring;
  measuring = null;
  const pt = project.points.find((p) => p.id === m.id);
  if (pt && !pt.scans && m.isNew) {
    project.points = project.points.filter((p) => p !== pt);
    if (selectedPoint === pt.id) selectedPoint = null;
    autosave();
  }
  host.status("Measuring cancelled");
  render();
}

function deletePoint(id: string) {
  if (!project) return;
  const i = project.points.findIndex((p) => p.id === id);
  if (i < 0) return;
  const pt = project.points[i];
  project.points.splice(i, 1);
  if (measuring?.id === id) measuring = null;
  if (stalled?.id === id) stalled = null;
  if (selectedPoint === id) selectedPoint = null;
  pushUndo(`Point #${i + 1} deleted`, () => project?.points.splice(i, 0, pt));
  autosave();
  render();
}

// ───────────────────────── drawing ─────────────────────────

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function classOf(v: number): number {
  const m = METRICS[metric];
  const i = m.steps.findIndex((t) => (m.higher ? v >= t : v <= t));
  return i < 0 ? 4 : i;
}

/** Class index → its signal colour; or any CSS custom property by name. */
function classColor(i: number | string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(typeof i === "number" ? CLASS_VARS[i] : i)
    .trim();
}

export function render() {
  if (!active) return;
  renderSide();
  renderStatus();
  draw();
}

/** Banner over the map: measuring progress, a failed point, or the scale-calibration step. */
function renderStatus() {
  const el = $("sv-status");
  let html = "";
  let err = false;
  const no = (id: string) => (project?.points.findIndex((p) => p.id === id) ?? -1) + 1;
  if (measuring) {
    const done = scansPerPoint - measuring.left;
    const dots = Array.from({ length: scansPerPoint }, (_, i) => `<i class="${i < done ? "done" : ""}"></i>`).join("");
    const sub = !host.running()
      ? "Scanning is paused"
      : measuring.err
        ? `Scan failed: ${measuring.err} — retrying (${measuring.fails}/${MAX_FAILS})`
        : measuring.skip
          ? "Waiting for the scan in progress to finish…"
          : `Scan ${Math.min(done + 1, scansPerPoint)} of ${scansPerPoint} — stay on the spot`;
    err = !!measuring.err;
    html =
      `<span class="dots" aria-hidden="true">${dots}</span><span class="msg">Measuring point #${no(measuring.id)}<small>${esc(sub)}</small></span>` +
      `<span class="btns">${host.running() ? "" : `<button data-st="resume" class="primary">Resume</button>`}<button data-st="cancel" title="Cancel (Esc)">Cancel</button></span>`;
  } else if (stalled) {
    err = true;
    html =
      `<span class="msg">Point #${no(stalled.id)} not measured<small>${esc(stalled.msg)}</small></span>` +
      `<span class="btns"><button data-st="retry" class="primary">Retry</button><button data-st="discard" title="Delete this point (Undo brings it back)">Delete</button></span>`;
  } else if (calib) {
    const step = !calib.a ? "Click the first of two points with a known distance" : !calib.b ? "Click the second point" : "Enter the real distance in the sidebar";
    html = `<span class="msg">Set scale<small>${step}</small></span><span class="btns"><button data-st="calib-cancel" title="Cancel (Esc)">Cancel</button></span>`;
  }
  el.hidden = !html;
  el.classList.toggle("err", err);
  if (el.dataset.html !== html) {
    keepFocus(el, ["data-st"], () => (el.innerHTML = html));
    el.dataset.html = html;
  }
}

function heatmap(samples: Sample[], w: number, h: number): HTMLCanvasElement | null {
  const m = METRICS[metric];
  if (!samples.length || (m.dbm && !samples.some((s) => s.v > FLOOR_DBM))) return null;
  const mask = project?.maskFrac ?? DEFAULT_MASK;
  const cols = Math.ceil(w / CELL_PX),
    rows = Math.ceil(h / CELL_PX);
  const key = `${metric}|${mask}|${cols}x${rows}|${samples.map((s) => `${s.x},${s.y},${s.v}`).join(";")}`;
  if (heat?.key === key) return heat.canvas;
  const px = samples.map((s) => ({ v: s.v, x: s.x * w, y: s.y * h }));
  const grid = idwGrid(px, cols, rows, CELL_PX, Math.hypot(w, h) * mask);
  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  const octx = off.getContext("2d")!;
  const data = octx.createImageData(cols, rows);
  const colors = CLASS_VARS.map((_, i) => rgb(classColor(i)));
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (Number.isNaN(v) || (m.dbm && v < NO_COVERAGE_DBM)) continue;
    data.data.set([...colors[classOf(v)], 255], i * 4);
  }
  octx.putImageData(data, 0, 0);
  const out = document.createElement("canvas");
  out.width = cols * CELL_PX;
  out.height = rows * CELL_PX;
  const hctx = out.getContext("2d")!;
  hctx.filter = `blur(${CELL_PX}px)`;
  hctx.drawImage(off, 0, 0, out.width, out.height);
  heat = { key, canvas: out };
  return out;
}

function draw() {
  if (!active) return;
  const cv = canvas();
  const wrap = cv.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const cw = wrap.clientWidth,
    ch = wrap.clientHeight;
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  $("sv-empty").hidden = !!project;
  markers = [];
  $("sv-zoom").hidden = !project;
  if (!project || !img?.complete || !img.naturalWidth) return;

  const k = mapScale();
  const ah = areaH(ch);
  const fit = Math.min(cw / project.imageW, ah / project.imageH);
  const baseW = project.imageW * fit,
    baseH = project.imageH * fit;
  view.w = baseW * zoom;
  view.h = baseH * zoom;
  // keep the canvas centre over the image
  pan.x = Math.max(-view.w / 2, Math.min(view.w / 2, pan.x));
  pan.y = Math.max(-view.h / 2, Math.min(view.h / 2, pan.y));
  view.x = (cw - view.w) / 2 + pan.x;
  view.y = (ah - view.h) / 2 + pan.y;
  $("sv-zoom-fit").textContent = `${Math.round(zoom * 100)}%`;
  paint(ctx, ch, view, baseW, baseH, k, true);
}

/** On-screen size of map labels and marks (--map-label in styles.css). */
function mapScale(): number {
  return (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--map-label")) || 11) / 11;
}

/** Height the plan fits into: the canvas minus a strip at the bottom for the legend, so at "fit" it never covers points. */
function areaH(ch: number): number {
  return Math.max(120, ch - Math.round(42 * mapScale() + 20));
}

/** Draw plan, heatmap, APs, points and legend into `ctx`. `k` scales marks and text; `live` = on-screen (hit targets, calibration). */
function paint(ctx: CanvasRenderingContext2D, ch: number, v: typeof view, baseW: number, baseH: number, k: number, live: boolean) {
  const p = project!;
  const tone = p.planTone ?? 0;
  ctx.save();
  ctx.filter = p.planGray ? "grayscale(1)" : "none";
  ctx.drawImage(img!, v.x, v.y, v.w, v.h);
  // darker: multiply the plan onto itself (white stays white, light grey lines get darker), up to 2 extra passes
  ctx.globalCompositeOperation = "multiply";
  for (let a = -tone / 50; a > 0; a--) {
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(img!, v.x, v.y, v.w, v.h);
  }
  ctx.restore();
  if (tone > 0) {
    ctx.fillStyle = `rgba(255,255,255,${tone / 110})`;
    ctx.fillRect(v.x, v.y, v.w, v.h);
  }

  const bssids = layerBssids();
  const radios = radiosOf();
  const values = p.points.map((pt) => pointValue(pt, bssids, radios));
  const samples = p.points.flatMap((pt, i) => (values[i] == null ? [] : [{ x: pt.x, y: pt.y, v: values[i]! }]));
  const hm = heatmap(samples, baseW, baseH);
  if (hm) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x, v.y, v.w, v.h);
    ctx.clip();
    ctx.globalAlpha = p.opacity ?? DEFAULT_OPACITY;
    const s = v.w / baseW;
    ctx.drawImage(hm, v.x, v.y, hm.width * s, hm.height * s);
    ctx.restore();
  }

  ctx.font = `${11 * k}px ` + getComputedStyle(document.body).fontFamily;
  // point labels always sit right-below their dot; AP name pills move around them (and each other)
  const ptLabel = (pt: SurveyPoint, i: number) =>
    live && measuring?.id === pt.id ? `#${i + 1} ${scansPerPoint - measuring.left}/${scansPerPoint}` : `#${i + 1} ${noData(values[i]) ? "–" : Math.round(values[i]!)}`;
  const taken: Box[] = p.points.flatMap((pt, i) => {
    const x = v.x + pt.x * v.w,
      y = v.y + pt.y * v.h;
    const r = POINT_R * k;
    return [
      { x: x - r, y: y - r, w: 2 * r, h: 2 * r },
      { x: x + 10 * k, y: y + 3 * k, w: ctx.measureText(ptLabel(pt, i)).width, h: 12 * k },
    ];
  });

  // APs: ✕ = estimated, ◆ = placed by the user
  for (const g of apGroups(bssids)) {
    const placed = p.apPos?.[g.key];
    const pos = placed ?? g.pos;
    if (!pos) continue;
    const x = v.x + pos.x * v.w,
      y = v.y + pos.y * v.h;
    if (live) markers.push({ x, y, group: g });
    const c = colorFor(g.key);
    const r = 6 * k;
    ctx.beginPath();
    if (placed) {
      ctx.moveTo(x, y - r - 2 * k);
      ctx.lineTo(x + r + 2 * k, y);
      ctx.lineTo(x, y + r + 2 * k);
      ctx.lineTo(x - r - 2 * k, y);
      ctx.closePath();
      ctx.fillStyle = c;
      ctx.fill();
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    } else {
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.lineCap = "round";
      ctx.lineWidth = 5.5 * k;
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.stroke();
      ctx.lineWidth = 3 * k;
      ctx.strokeStyle = c;
      ctx.stroke();
      ctx.lineCap = "butt";
    }
    // label as a pill in the AP colour, so it reads on any plan / heatmap colour
    const tw = ctx.measureText(g.label).width;
    const pill = (lx: number, cy: number): Box => ({ x: lx - 3 * k, y: cy - 7 * k, w: tw + 6 * k, h: 14 * k });
    // right-up, right-down, left-up, left-down: first spot that covers no point or other label
    const spots: [number, number][] = [
      [x + 10 * k, y - 9 * k],
      [x + 10 * k, y + 9 * k],
      [x - 10 * k - tw, y - 9 * k],
      [x - 10 * k - tw, y + 9 * k],
    ];
    const [lx, cy] = spots.find(([a, b]) => !taken.some((t) => overlaps(t, pill(a, b)))) ?? spots[0];
    taken.push(pill(lx, cy));
    ctx.beginPath();
    ctx.roundRect(lx - 3 * k, cy - 7 * k, tw + 6 * k, 14 * k, 3 * k);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.lineWidth = 1 * k;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.stroke();
    ctx.fillStyle = Number(c.match(/(\d+)%\)$/)?.[1] ?? 50) >= 50 ? "#000" : "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(g.label, lx, cy);
    ctx.textBaseline = "alphabetic";
  }

  // measured points
  p.points.forEach((pt, i) => {
    const x = v.x + pt.x * v.w,
      y = v.y + pt.y * v.h;
    const val = values[i];
    const isMeasuring = live && measuring?.id === pt.id;
    const failed = live && stalled?.id === pt.id;
    ctx.beginPath();
    ctx.arc(x, y, POINT_R * k, 0, Math.PI * 2);
    ctx.fillStyle = noData(val) ? "#888" : classColor(classOf(val));
    ctx.fill();
    ctx.lineWidth = (live && pt.id === selectedPoint ? 3 : 1.5) * k;
    ctx.strokeStyle = "#000";
    ctx.stroke();
    if (isMeasuring || failed) {
      // ring around the spot being measured (accent) or the one that failed (danger)
      ctx.beginPath();
      ctx.arc(x, y, (POINT_R + 5) * k, 0, Math.PI * 2);
      ctx.lineWidth = 3 * k;
      ctx.strokeStyle = classColor(failed ? "--danger" : "--accent");
      ctx.setLineDash(isMeasuring ? [5, 3] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    halo(ctx, ptLabel(pt, i), x + 10 * k, y + 13 * k, k);
  });

  // calibration line
  if (live && calib?.a) {
    const a = { x: v.x + calib.a.x * v.w, y: v.y + calib.a.y * v.h };
    ctx.fillStyle = ctx.strokeStyle = classColor("--accent");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
    ctx.fill();
    if (calib.b) {
      const b = { x: v.x + calib.b.x * v.w, y: v.y + calib.b.y * v.h };
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  legend(ctx, ch, v, k, live);
}

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function halo(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, k: number) {
  ctx.lineWidth = 3 * k;
  ctx.lineJoin = "round"; // miter spikes on glyph corners otherwise
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#000";
  ctx.fillText(text, x, y);
}

/** Colour key (and scale bar when calibrated) in the bottom-left corner. */
function legend(ctx: CanvasRenderingContext2D, ch: number, v: typeof view, k: number, live: boolean) {
  const m = METRICS[metric];
  const pad = 6 * k,
    sw = 10 * k,
    lh = 15 * k;
  const title = `${m.label} (${m.unit}) · ${layerLabel()}`;
  const items = m.legend.map((t, i) => ({ t, c: classColor(i), w: sw + 4 * k + ctx.measureText(t).width + 8 * k }));
  const w = Math.max(ctx.measureText(title).width, items.reduce((s, it) => s + it.w, 0)) + pad * 2;
  const h = lh * 2 + pad * 2;
  // on screen: pinned to the map's bottom-left corner whatever the zoom / pan (at "fit" the plan leaves
  // that strip free, see areaH); export: in the band under the plan
  const x0 = 10 * k,
    y0 = ch - 10 * k - h;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "middle";
  ctx.fillText(title, x0 + pad, y0 + pad + lh / 2);
  let x = x0 + pad;
  const y = y0 + pad + lh * 1.5;
  for (const it of items) {
    ctx.fillStyle = it.c;
    ctx.fillRect(x, y - sw / 2, sw, sw);
    ctx.fillStyle = "#000";
    ctx.fillText(it.t, x + sw + 4 * k, y);
    x += it.w;
  }

  const mPerPx = project!.mPerPx;
  if (mPerPx) {
    const mPerView = (mPerPx * project!.imageW) / v.w; // metres per canvas px
    const len = niceLength(150 * k * mPerView);
    const bw = len / mPerView;
    // on screen: beside the legend on the same white panel style; export: above the legend
    const label = `${len} m`;
    const bx = live ? x0 + w + 8 * k + pad : x0;
    const by = live ? y0 + h / 2 + 4 * k : y0 - 12 * k;
    if (live) {
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fillRect(bx - pad, y0, bw + 6 * k + ctx.measureText(label).width + pad * 2, h);
    }
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4 * k);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + bw, by);
    ctx.lineTo(bx + bw, by - 4 * k);
    ctx.stroke();
    if (live) {
      ctx.fillStyle = "#000";
      ctx.fillText(label, bx + bw + 6 * k, by - 2 * k);
    } else halo(ctx, label, bx + bw + 6 * k, by - 2 * k, k);
  }
  ctx.textBaseline = "alphabetic";
}

async function exportPng() {
  if (!project || !img) return;
  const s = Math.min(1, EXPORT_MAX / Math.max(project.imageW, project.imageH));
  const w = Math.round(project.imageW * s),
    h = Math.round(project.imageH * s);
  const k = Math.max(1, Math.max(w, h) / 1200);
  // white band under the plan for the legend / scale bar / title, so they don't cover measurements
  const band = Math.round(72 * k);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h + band;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h + band);
  paint(ctx, h + band, { x: 0, y: 0, w, h }, w, h, k, false);
  ctx.font = `bold ${13 * k}px ` + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = "right";
  halo(ctx, `${project.name} · ${new Date().toLocaleDateString()}`, w - 10 * k, h + band - 12 * k, k);
  const blob = await new Promise<Blob | null>((ok) => out.toBlob(ok, "image/png"));
  if (!blob) return host.status("PNG export failed");
  const tag = `${metric}-${layer === "best" ? "all" : layer.replace(/[^\w.-]+/g, "_")}`;
  await api.saveFile(`${project.name}-${tag}.png`, new Uint8Array(await blob.arrayBuffer()), "png");
}

function renderSide() {
  const sel = $<HTMLSelectElement>("sv-layer");
  const aps = $("sv-aps");
  const pts = $("sv-points");
  const mask = project?.maskFrac ?? DEFAULT_MASK;
  $<HTMLInputElement>("sv-opacity").value = String(Math.round((project?.opacity ?? DEFAULT_OPACITY) * 100));
  $<HTMLInputElement>("sv-gray").checked = !!project?.planGray;
  $<HTMLInputElement>("sv-tone").value = String(project?.planTone ?? 0);
  $<HTMLInputElement>("sv-mask").value = String(Math.round(mask * 100));
  $<HTMLSelectElement>("sv-metric").value = metric;
  renderScale();
  for (const id of ["sv-save", "sv-export", "sv-scale-set"]) $<HTMLButtonElement>(id).disabled = !project;
  renderSaved();
  const secs = Math.round((scansPerPoint * host.intervalMs()) / 1000);
  $("sv-eta").textContent = instant ? "instant" : `≈ ${secs} s / point`;
  $("sv-aps-n").textContent = $("sv-points-n").textContent = "";
  if (!project) {
    sel.innerHTML = `<option value="best">Best signal</option>`;
    aps.innerHTML = "";
    pts.innerHTML = `<li class="sv-none">Open a floor plan to start.</li>`;
    return;
  }
  const vis = visibleBssids();
  const bss = project.bss;
  const ssids = [...new Set(vis.map((b) => ssidLabel(bss[b])))].sort();
  const groups = apGroups(vis);
  const opt = (v: string, label: string) => `<option value="${esc(v)}"${v === layer ? " selected" : ""}>${esc(label)}</option>`;
  // BSSIDs only for the AP being looked at (picked AP, or the AP of the picked BSSID): hundreds of rows otherwise
  const [kind, ...rest] = layer.split(":");
  const lv = rest.join(":");
  const apOfLayer = kind === "ap" ? lv : kind === "bssid" && bss[lv] ? apKey(lv, bss[lv].apName) : null;
  const apBssids = apOfLayer ? vis.filter((b) => apKey(b, bss[b].apName) === apOfLayer).sort() : [];
  sel.innerHTML =
    opt("best", "Best signal (all visible)") +
    `<optgroup label="SSID">${ssids.map((s) => opt(`ssid:${s}`, s)).join("")}</optgroup>` +
    `<optgroup label="AP">${groups.map((g) => opt(`ap:${g.key}`, `${g.label} (${g.ssids.join(", ")})`)).join("")}</optgroup>` +
    (apBssids.length
      ? `<optgroup label="BSSIDs of this AP">${apBssids.map((b) => opt(`bssid:${b}`, `${b} ${ssidLabel(bss[b])} ch${bss[b].channel}`)).join("")}</optgroup>`
      : "");

  const cols = AP_COLS.filter((c) => !apView.hidden.includes(c.key));
  const sc = AP_COLS.find((c) => c.key === apView.sort) ?? AP_COLS[0];
  const dir = apView.asc ? 1 : -1;
  const rows = groups.slice().sort((a, b) => {
    const x = sc.sort(a),
      y = sc.sort(b);
    return (x < y ? -1 : x > y ? 1 : b.best - a.best) * dir;
  });
  const arrow = (k: string) => (apView.sort === k ? `<span class="arrow">${apView.asc ? "▲" : "▼"}</span>` : "");
  $("sv-aps-n").textContent = rows.length ? String(rows.length) : "";
  $("sv-points-n").textContent = project.points.length ? String(project.points.length) : "";
  const apHtml =
    `<tr>${cols.map((c) => `<th data-sort="${c.key}" data-kbd tabindex="0" class="${c.num ? "num" : ""}" title="${esc(c.title ?? c.label)}">${c.label}${arrow(c.key)}</th>`).join("")}<th class="act"></th></tr>` +
    rows
      .map(
        (g) =>
          `<tr data-layer="${esc(`ap:${g.key}`)}" data-kbd tabindex="0" class="${layer === `ap:${g.key}` ? "sel" : ""}">` +
          cols.map((c) => `<td class="${c.num ? "num" : ""}" title="${c.html(g).replace(/<[^>]+>/g, "")}">${c.html(g)}</td>`).join("") +
          `<td>${project!.apPos?.[g.key] ? `<button data-unplace="${esc(g.key)}" title="Use the estimated position" aria-label="Use the estimated position">↺</button>` : ""}</td></tr>`,
      )
      .join("");
  keepFocus(aps, ["data-sort", "data-layer", "data-unplace"], () => (aps.innerHTML = apHtml));

  // each point's value for the current layer / metric, so weak spots can be found from the list
  const lb = layerBssids();
  const radios = radiosOf();
  const unit = { signal: "", second: "", snr: " dB", cci: "" }[metric];
  const valHtml = (p: SurveyPoint) => {
    const v = pointValue(p, lb, radios);
    return noData(v)
      ? `<span class="val none" title="${METRICS[metric].label}: no data">–</span>`
      : `<span class="val" title="${METRICS[metric].label}"><i class="lvl" style="background:${classColor(classOf(v))}"></i>${Math.round(v)}${unit}</span>`;
  };
  const ptHtml = project.points.length
    ? project.points
        .map((p, i) => {
          const [cls, status] =
            measuring?.id === p.id
              ? ["busy", `Measuring ${scansPerPoint - measuring.left}/${scansPerPoint}…`]
              : stalled?.id === p.id
                ? ["err", "Scan failed"]
                : p.scans
                  ? ["", `${new Date(p.t).toLocaleTimeString()} · ${Object.keys(p.rssi).length} BSS`]
                  : ["muted", "Not measured"];
          return `<li data-point="${esc(p.id)}" data-kbd tabindex="0" class="${p.id === selectedPoint ? "sel" : ""}"><span class="no">${i + 1}</span>${valHtml(p)}<span class="st ${cls}">${status}</span>
        <button data-remeasure="${esc(p.id)}" title="Measure again (R)" aria-label="Measure point ${i + 1} again">↻</button><button data-del="${esc(p.id)}" title="Delete (Del)" aria-label="Delete point ${i + 1}">×</button></li>`;
        })
        .join("")
    : `<li class="sv-none">Click the map where you stand to measure the first point.</li>`;
  keepFocus(pts, ["data-point", "data-remeasure", "data-del"], () => (pts.innerHTML = ptHtml));
  if (selectedPoint) pts.querySelector(`li[data-point="${CSS.escape(selectedPoint)}"]`)?.scrollIntoView({ block: "nearest" });
}

function renderScale() {
  const mask = project?.maskFrac ?? DEFAULT_MASK;
  const diagM = project?.mPerPx ? Math.hypot(project.imageW, project.imageH) * project.mPerPx : 0;
  $("sv-mask-v").textContent = diagM ? `${(mask * diagM).toFixed(1)} m` : `${Math.round(mask * 100)}%`;
  $("sv-scale-text").textContent = !project?.mPerPx
    ? "not set"
    : `${(project.imageW * project.mPerPx).toFixed(1)} × ${(project.imageH * project.mPerPx).toFixed(1)} m`;
  $("sv-scale-set").textContent = calib ? "Cancel" : "Set…";
  $("sv-scale-input").hidden = !calib?.b;
}

// ───────────────────────── interaction ─────────────────────────

function hit(x: number, y: number): { point?: SurveyPoint; marker?: ApGroup } | null {
  if (!project) return null;
  // nearest within reach, so close neighbours still pick the one under the pointer
  let best: { point?: SurveyPoint; marker?: ApGroup } | null = null;
  let bd = HIT_R;
  for (const p of project.points) {
    const d = Math.hypot(view.x + p.x * view.w - x, view.y + p.y * view.h - y);
    if (d < bd) [best, bd] = [{ point: p }, d];
  }
  if (best) return best;
  for (const m of markers) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < bd) [best, bd] = [{ marker: m.group }, d];
  }
  return best;
}

function tooltip(h: { point?: SurveyPoint; marker?: ApGroup }): string {
  const bss = project!.bss;
  if (h.marker) {
    const g = h.marker;
    const how = project!.apPos?.[g.key] ? "placed" : "estimated position — drag to place";
    return `<b>${esc(g.label)}</b> (${how})<br>${esc(g.ssids.join(", "))} · ch ${esc(g.channels.join(","))}<br>best ${esc(String(g.best))} dBm at ${g.heard} point(s)`;
  }
  const p = h.point!;
  const set = new Set(layerBssids());
  const top = Object.entries(p.rssi)
    .filter(([b]) => set.has(b))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([b, v]) => {
      const n = p.noise?.[b];
      return esc(`${v} dBm${n != null ? ` (SNR ${v - n})` : ""} · ${ssidLabel(bss[b])} · ch${bss[b].channel} · ${b}`);
    });
  return `<b>Point #${project!.points.indexOf(p) + 1}</b> <small>drag to move</small><br>${top.join("<br>") || "nothing heard"}`;
}

async function readFile(input: HTMLInputElement, as: "text" | "dataURL"): Promise<string | null> {
  const f = input.files?.[0];
  input.value = "";
  if (!f) return null;
  const r = new FileReader();
  const done = new Promise<string>((ok, ng) => {
    r.onload = () => ok(r.result as string);
    r.onerror = () => ng(r.error);
  });
  if (as === "text") r.readAsText(f);
  else r.readAsDataURL(f);
  return done;
}

function zoomAt(factor: number, cx: number, cy: number) {
  const nz = Math.max(1, Math.min(MAX_ZOOM, zoom * factor));
  if (!project || nz === zoom) return;
  const u = (cx - view.x) / view.w,
    v = (cy - view.y) / view.h;
  const w = (view.w / zoom) * nz,
    h = (view.h / zoom) * nz;
  const cv = canvas();
  pan = { x: cx - u * w - (cv.clientWidth - w) / 2, y: cy - v * h - (areaH(cv.clientHeight) - h) / 2 };
  zoom = nz;
  draw();
}

function zoomCentre(factor: number) {
  const cv = canvas();
  zoomAt(factor, cv.clientWidth / 2, cv.clientHeight / 2);
}

function setHand(on: boolean) {
  hand = on;
  const b = $("sv-hand");
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  canvas().style.cursor = on ? "grab" : "crosshair";
}

function zoomFit() {
  zoom = 1;
  pan = { x: 0, y: 0 };
  draw();
}

const toImage = (ox: number, oy: number) => ({ x: (ox - view.x) / view.w, y: (oy - view.y) / view.h });
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function clickAt(ox: number, oy: number) {
  if (!project) return;
  const { x, y } = toImage(ox, oy);
  const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  if (calib) {
    if (!inside || calib.b) return;
    if (!calib.a) {
      calib.a = { x, y };
      host.status("Scale: click the second point");
    } else {
      calib.b = { x, y };
      host.status("Scale: enter the real distance between the two points");
    }
    render();
    if (calib.b) $<HTMLInputElement>("sv-scale-m").focus();
    return;
  }
  const hh = hit(ox, oy);
  if (stalled && !hh) stalled = null; // moving on: the failed point stays in the list as "Not measured"
  if (hh?.marker) {
    layer = `ap:${hh.marker.key}`;
    return render();
  }
  if (hh?.point) {
    selectedPoint = hh.point.id;
    return render();
  }
  if (!inside) return;
  if (measuring) {
    host.status("Still measuring the previous point — wait for it or press Esc to cancel");
    flashStatus();
    return;
  }
  const pt: SurveyPoint = { id: crypto.randomUUID(), x, y, t: Date.now(), scans: 0, rssi: {} };
  project.points.push(pt);
  pushUndo(`Point #${project.points.length} added`, () => {
    if (!project) return;
    project.points = project.points.filter((p) => p !== pt);
    if (measuring?.id === pt.id) measuring = null;
    if (selectedPoint === pt.id) selectedPoint = null;
  });
  measure(pt, true);
}

/** Nudge the banner when a click is refused, so the eye finds why. */
function flashStatus() {
  $("sv-status").animate?.([{ transform: "translateX(-50%) scale(1.06)" }, { transform: "translateX(-50%) scale(1)" }], { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
}

function applyScale() {
  const input = $<HTMLInputElement>("sv-scale-m");
  const m = Number(input.value);
  if (!project || !calib?.a || !calib.b) return;
  const px = Math.hypot((calib.b.x - calib.a.x) * project.imageW, (calib.b.y - calib.a.y) * project.imageH);
  input.setCustomValidity(!(m > 0) ? "Enter a distance greater than 0" : px < 1 ? "The two points are too close together" : "");
  if (!input.reportValidity()) return;
  const prev = project.mPerPx; // undefined = no scale yet
  project.mPerPx = m / px;
  calib = null;
  pushUndo(`Scale set: ${m} m`, () => project && (project.mPerPx = prev));
  autosave();
  render();
}

export function setActive(on: boolean) {
  active = on;
  render();
}

export async function init(h: SurveyHost) {
  host = h;
  const cv = canvas();
  const tip = $("sv-tip");

  // drag: empty area = pan, point = move it, AP marker = place the AP. Moved < 4px = click.
  let drag: {
    kind: "pan" | "point" | "ap";
    id: string;
    x: number;
    y: number;
    px: number;
    py: number;
    moved: boolean;
    click: boolean;
    from: { x: number; y: number } | null;
  } | null = null;
  cv.onpointerdown = (e) => {
    if ((e.button !== 0 && e.button !== 1) || !project) return;
    e.preventDefault(); // middle button: no autoscroll
    cv.setPointerCapture(e.pointerId);
    const panOnly = hand || e.button === 1;
    const hh = calib || panOnly ? null : hit(e.offsetX, e.offsetY);
    const kind = hh?.point ? "point" : hh?.marker ? "ap" : "pan";
    const id = hh?.point?.id ?? hh?.marker?.key ?? "";
    const pt = hh?.point;
    // where it was, for Undo
    const from = pt ? { x: pt.x, y: pt.y } : kind === "ap" ? project.apPos?.[id] ?? null : null;
    drag = { kind, id, x: e.offsetX, y: e.offsetY, px: pan.x, py: pan.y, moved: false, click: !panOnly, from };
    if (panOnly) cv.style.cursor = "grabbing";
  };
  cv.onauxclick = (e) => e.preventDefault();
  cv.onpointerup = (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.click) cv.style.cursor = hand ? "grab" : "crosshair";
    if (!d.moved) return d.click ? clickAt(e.offsetX, e.offsetY) : undefined;
    if (d.kind === "point" && d.from) {
      const pt = project?.points.find((q) => q.id === d.id);
      const from = d.from;
      if (pt) pushUndo(`Point #${project!.points.indexOf(pt) + 1} moved`, () => Object.assign(pt, from));
    } else if (d.kind === "ap") {
      const from = d.from;
      pushUndo(from ? "AP moved" : "AP placed", () => {
        if (!project?.apPos) return;
        if (from) project.apPos[d.id] = from;
        else delete project.apPos[d.id];
      });
    }
    if (d.kind !== "pan") {
      autosave();
      render();
    }
  };
  cv.onpointercancel = () => (drag = null);
  cv.onwheel = (e) => {
    if (!project) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : 1;
    // trackpad pinch arrives as ctrl+wheel; ⌘/Ctrl + mouse wheel zooms too. Plain wheel / two-finger swipe pans.
    if (e.ctrlKey || e.metaKey) return zoomAt(Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002)), e.offsetX, e.offsetY);
    pan = { x: pan.x - e.deltaX * unit, y: pan.y - e.deltaY * unit };
    draw();
  };

  cv.onpointermove = (e) => {
    if (drag && project) {
      if (!drag.moved && Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) < 4) return;
      drag.moved = true;
      tip.hidden = true;
      const at = toImage(e.offsetX, e.offsetY);
      const pos = { x: clamp01(at.x), y: clamp01(at.y) };
      if (drag.kind === "pan") {
        cv.style.cursor = "grabbing";
        pan = { x: drag.px + e.offsetX - drag.x, y: drag.py + e.offsetY - drag.y };
      } else if (drag.kind === "point") {
        const p = project.points.find((q) => q.id === drag!.id);
        if (p) Object.assign(p, pos);
      } else {
        (project.apPos ??= {})[drag.id] = pos;
      }
      return draw();
    }
    const hh = calib ? null : hit(e.offsetX, e.offsetY);
    cv.style.cursor = !project ? "default" : hand ? "grab" : hh ? "move" : "crosshair";
    if (!hh) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = tooltip(hh);
    tip.hidden = false;
    tip.style.left = `${Math.min(e.offsetX + 14, cv.clientWidth - tip.offsetWidth - 6)}px`;
    tip.style.top = `${Math.max(4, e.offsetY - tip.offsetHeight - 10)}px`;
  };
  cv.onmouseleave = () => (tip.hidden = true);
  new ResizeObserver(() => draw()).observe(cv.parentElement!);

  // sidebar width: drag the splitter, double-click to reset (persisted per machine)
  const surveyEl = $("survey");
  const setSide = (w: string | null) => (w ? surveyEl.style.setProperty("--side", w) : surveyEl.style.removeProperty("--side"));
  try {
    setSide(localStorage.getItem("wifisight.svSide"));
  } catch {
    /* default width */
  }
  const split = $("sv-splitter");
  split.onpointerdown = (e) => {
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    const rect = surveyEl.getBoundingClientRect();
    split.onpointermove = (ev) => setSide(`${Math.round(Math.max(260, Math.min(rect.width - 320, rect.right - ev.clientX)))}px`);
    split.onpointerup = () => {
      split.onpointermove = null;
      try {
        localStorage.setItem("wifisight.svSide", surveyEl.style.getPropertyValue("--side"));
      } catch {
        /* storage unavailable */
      }
    };
  };
  split.ondblclick = () => {
    setSide(null);
    try {
      localStorage.removeItem("wifisight.svSide");
    } catch {
      /* storage unavailable */
    }
  };
  $("sv-zoom-in").onclick = () => zoomCentre(1.5);
  $("sv-hand").onclick = () => setHand(!hand);
  $("sv-zoom-out").onclick = () => zoomCentre(1 / 1.5);
  $("sv-zoom-fit").onclick = zoomFit;

  $<HTMLSelectElement>("sv-layer").onchange = (e) => {
    layer = (e.target as HTMLSelectElement).value;
    render();
  };
  $<HTMLSelectElement>("sv-metric").onchange = (e) => {
    metric = (e.target as HTMLSelectElement).value as Metric;
    render();
  };
  $<HTMLSelectElement>("sv-n").onchange = (e) => {
    const v = Number((e.target as HTMLSelectElement).value);
    instant = v === 0;
    scansPerPoint = Math.max(1, v);
    renderSide();
  };

  // display sliders: redraw while dragging, save on release
  const opacity = $<HTMLInputElement>("sv-opacity");
  const mask = $<HTMLInputElement>("sv-mask");
  opacity.oninput = () => {
    if (!project) return;
    project.opacity = Number(opacity.value) / 100;
    draw();
  };
  mask.oninput = () => {
    if (!project) return;
    project.maskFrac = Number(mask.value) / 100;
    renderScale();
    draw();
  };
  opacity.onchange = mask.onchange = () => autosave();
  const tone = $<HTMLInputElement>("sv-tone");
  tone.oninput = () => {
    if (!project) return;
    project.planTone = Number(tone.value);
    draw();
  };
  tone.onchange = () => autosave();
  tone.ondblclick = () => {
    tone.value = "0";
    tone.oninput!(new Event("input"));
    autosave();
  };
  $<HTMLInputElement>("sv-gray").onchange = (e) => {
    if (!project) return;
    project.planGray = (e.target as HTMLInputElement).checked;
    draw();
    autosave();
  };

  const beepBox = $<HTMLInputElement>("sv-beep");
  try {
    beepBox.checked = localStorage.getItem("wifisight.beep") === "1";
  } catch {
    /* storage unavailable */
  }
  beepBox.onchange = () => {
    try {
      localStorage.setItem("wifisight.beep", beepBox.checked ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };

  // scale calibration
  $("sv-scale-set").onclick = () => {
    if (!project) return;
    calib = calib ? null : {};
    host.status(calib ? "Scale: click the first of two points with a known distance" : "");
    render();
  };
  $("sv-scale-ok").onclick = applyScale;
  $("sv-scale-cancel").onclick = () => {
    calib = null;
    render();
  };
  $("sv-scale-m").onkeydown = (e) => {
    if (e.key === "Enter") applyScale();
  };
  $<HTMLInputElement>("sv-scale-m").oninput = (e) => (e.target as HTMLInputElement).setCustomValidity("");

  // AP list: click header = sort, Columns ▾ / right-click header = show/hide columns
  try {
    const saved = JSON.parse(localStorage.getItem(AP_VIEW_KEY) ?? "null");
    if (saved?.sort) apView = saved;
  } catch {
    /* default view */
  }
  const colPop = $("sv-col-pop");
  const openCols = (x: number, y: number) => {
    colPop.innerHTML = AP_COLS.slice(1)
      .map((c) => `<label class="check"><input type="checkbox" data-col="${c.key}"${apView.hidden.includes(c.key) ? "" : " checked"} /> ${c.label}</label>`)
      .join("");
    colPop.style.left = `${Math.min(x, innerWidth - 180)}px`;
    colPop.style.top = `${y}px`;
    colPop.hidden = false;
  };
  $("sv-ap-cols").onclick = (e) => {
    e.stopPropagation();
    const r = (e.target as HTMLElement).getBoundingClientRect();
    openCols(r.left, r.bottom + 4);
  };
  $("sv-aps").oncontextmenu = (e) => {
    if (!(e.target as HTMLElement).closest("th")) return;
    e.preventDefault();
    e.stopPropagation();
    openCols(e.clientX, e.clientY);
  };
  colPop.onclick = (e) => e.stopPropagation();
  colPop.onchange = (e) => {
    const k = (e.target as HTMLInputElement).dataset.col!;
    apView.hidden = apView.hidden.includes(k) ? apView.hidden.filter((x) => x !== k) : [...apView.hidden, k];
    saveApView();
    renderSide();
  };
  document.addEventListener("click", () => (colPop.hidden = true));

  $("sv-aps").onclick = (e) => {
    const t = e.target as HTMLElement;
    const th = t.closest<HTMLElement>("th[data-sort]");
    if (th) {
      const k = th.dataset.sort!;
      if (apView.sort === k) apView.asc = !apView.asc;
      else apView = { ...apView, sort: k, asc: !AP_COLS.find((c) => c.key === k)!.num };
      saveApView();
      return renderSide();
    }
    if (t.dataset.unplace && project?.apPos) {
      const k = t.dataset.unplace;
      const was = project.apPos[k];
      delete project.apPos[k];
      pushUndo("AP back to its estimated position", () => project && ((project.apPos ??= {})[k] = was));
      autosave();
      return render();
    }
    const tr = t.closest<HTMLElement>("tr[data-layer]");
    if (!tr) return;
    layer = layer === tr.dataset.layer ? "best" : tr.dataset.layer!;
    render();
  };
  $("sv-points").onclick = (e) => {
    const t = e.target as HTMLElement;
    const pt = (id?: string) => project?.points.find((p) => p.id === id);
    if (t.dataset.del) return deletePoint(t.dataset.del);
    if (t.dataset.remeasure) {
      if (measuring) return host.status("Still measuring the previous point — wait for it or press Esc to cancel");
      const p = pt(t.dataset.remeasure);
      if (p) measure(p);
      return;
    }
    const li = t.closest<HTMLElement>("li[data-point]");
    if (li) {
      selectedPoint = li.dataset.point!;
      render();
    }
  };
  $("sv-status").onclick = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-st]")?.dataset.st;
    if (act === "cancel") cancelMeasure();
    else if (act === "resume") {
      host.ensureRunning();
      render();
    } else if (act === "calib-cancel") {
      calib = null;
      host.status("");
      render();
    } else if (act === "retry" && stalled) {
      const p = project?.points.find((q) => q.id === stalled!.id);
      if (p) measure(p, !p.scans);
    } else if (act === "discard" && stalled) {
      deletePoint(stalled.id);
    }
  };
  $("sv-toast").onclick = (e) => {
    if ((e.target as HTMLElement).closest("[data-undo]")) undoLast();
  };

  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (!active || !project || t.matches("input, select, textarea") || document.querySelector("dialog[open]")) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      return undoLast();
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (measuring) return cancelMeasure();
      if (calib) {
        calib = null;
        host.status("");
        return render();
      }
      if (stalled) {
        stalled = null;
        return render();
      }
      if (selectedPoint) {
        selectedPoint = null;
        return render();
      }
      return;
    }
    if ((e.key === "r" || e.key === "R") && selectedPoint && !measuring) {
      const p = project.points.find((q) => q.id === selectedPoint);
      if (p) measure(p, !p.scans);
      return;
    }
    if (e.key === "+" || e.key === "=") return zoomCentre(1.5);
    if (e.key === "-") return zoomCentre(1 / 1.5);
    if (e.key === "0") return zoomFit();
    if (e.key === "h" || e.key === "H") return setHand(!hand);
    if (!selectedPoint || t.matches("button")) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deletePoint(selectedPoint);
    }
  });

  // floor plan / project files
  $("sv-open-plan").onclick = $("sv-empty-open").onclick = () => $("sv-file-plan").click();
  $("sv-open").onclick = () => $("sv-file-proj").click();
  $("sv-export").onclick = () => exportPng();
  $<HTMLInputElement>("sv-file-plan").onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    const name = input.files?.[0]?.name.replace(/\.[^.]+$/, "") ?? "survey";
    const url = await readFile(input, "dataURL");
    if (!url) return;
    if (!(await confirmReplace("Start a new survey"))) return;
    const im = new Image();
    im.onload = () => replaceProject({ app: "wifisight", kind: "survey", version: 1, name, image: url, imageW: im.naturalWidth, imageH: im.naturalHeight, bss: {}, points: [] });
    im.onerror = () => host.status("Could not load that image (use PNG / JPEG)");
    im.src = url;
  };
  $<HTMLInputElement>("sv-file-proj").onchange = async (e) => {
    try {
      const text = await readFile(e.target as HTMLInputElement, "text");
      if (!text) return;
      const next = parseProject(text);
      if (!(await confirmReplace(`Open “${next.name}”`))) return;
      replaceProject(next);
    } catch (err) {
      host.status(`Could not open that file: ${err instanceof SyntaxError ? "not valid JSON" : String(err).replace(/^Error: /, "")}`);
    }
  };
  $("sv-save").onclick = async () => {
    if (!project) return;
    await api.saveFile(`${project.name}.survey.json`, JSON.stringify(project), "json");
  };

  // restore the last session
  try {
    const text = await api.autosaveRead();
    if (text) loadProject(parseProject(text));
  } catch {
    /* no or unreadable autosave */
  }
}
