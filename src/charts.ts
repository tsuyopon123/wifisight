import type { Band, Track } from "./types";
import { ssidLabel, withAlpha } from "./util";

export type Tab = "signal" | "2.4" | "5" | "6" | "load";

interface Hit {
  bssid: string;
  html: string;
}

interface Ctx {
  c: CanvasRenderingContext2D;
  w: number;
  h: number;
  fg: string;
  fg2: string;
  fg3: string;
  line: string;
  bg3: string;
  accent: string;
}

const PAD = { l: 44, r: 14, t: 12, b: 26 };
const RSSI_MIN = -100;
const RSSI_MAX = -20;

function setup(canvas: HTMLCanvasElement): Ctx {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const c = canvas.getContext("2d")!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const v = getComputedStyle(document.documentElement);
  const g = (k: string) => v.getPropertyValue(k).trim();
  c.font = "11px " + g("--sans");
  return { c, w, h, fg: g("--fg"), fg2: g("--fg-2"), fg3: g("--fg-3"), line: g("--line"), bg3: g("--bg-3"), accent: g("--accent") };
}

function yOf(x: Ctx, rssi: number) {
  const ih = x.h - PAD.t - PAD.b;
  return PAD.t + ((RSSI_MAX - rssi) / (RSSI_MAX - RSSI_MIN)) * ih;
}

function rssiAxis(x: Ctx) {
  const { c } = x;
  c.textAlign = "right";
  c.textBaseline = "middle";
  for (let r = RSSI_MIN; r <= RSSI_MAX; r += 10) {
    const y = yOf(x, r);
    c.strokeStyle = x.line;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(PAD.l, y + 0.5);
    c.lineTo(x.w - PAD.r, y + 0.5);
    c.stroke();
    c.fillStyle = x.fg3;
    c.fillText(String(r), PAD.l - 6, y);
  }
  c.save();
  c.translate(11, PAD.t + (x.h - PAD.t - PAD.b) / 2);
  c.rotate(-Math.PI / 2);
  c.textAlign = "center";
  c.fillText("dBm", 0, 0);
  c.restore();
}

// ───────────────────────── Signal over time ─────────────────────────

export class ChartView {
  private hits: { test: (mx: number, my: number) => number; hit: Hit }[] = [];

  constructor(private canvas: HTMLCanvasElement) {}

  draw(tab: Tab, tracks: Track[], selected: string | null, now: number, windowMs: number, latestScan: number) {
    this.hits = [];
    if (tab === "signal") this.signal(tracks, selected, now, windowMs);
    else if (tab === "load") this.load(tracks.filter((t) => t.lastSeen >= latestScan));
    else this.spectrum(tab, tracks.filter((t) => t.lastSeen >= latestScan), selected);
  }

  /** Returns best hit at mouse position (smaller score = better). */
  hitTest(mx: number, my: number): Hit | null {
    let best: Hit | null = null;
    let score = Infinity;
    for (const h of this.hits) {
      const s = h.test(mx, my);
      if (s < score) {
        score = s;
        best = h.hit;
      }
    }
    return best;
  }

  private signal(tracks: Track[], selected: string | null, now: number, windowMs: number) {
    const x = setup(this.canvas);
    const { c } = x;
    rssiAxis(x);
    const t0 = now - windowMs;
    const iw = x.w - PAD.l - PAD.r;
    const xOf = (t: number) => PAD.l + ((t - t0) / windowMs) * iw;

    // time axis
    c.textAlign = "center";
    c.textBaseline = "top";
    c.fillStyle = x.fg3;
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const t = t0 + (windowMs * i) / steps;
      const px = xOf(t);
      c.strokeStyle = x.line;
      c.beginPath();
      c.moveTo(px + 0.5, PAD.t);
      c.lineTo(px + 0.5, x.h - PAD.b);
      c.stroke();
      const d = new Date(t);
      c.textAlign = i === 0 ? "left" : i === steps ? "right" : "center";
      c.fillText(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), px, x.h - PAD.b + 6);
    }

    const ordered = tracks.filter((t) => !t.hidden).sort((a, b) => Number(a.info.bssid === selected) - Number(b.info.bssid === selected));
    c.save();
    c.beginPath();
    c.rect(PAD.l, PAD.t, iw, x.h - PAD.t - PAD.b);
    c.clip();
    for (const t of ordered) {
      const isSel = t.info.bssid === selected;
      const pts = t.history.filter((s) => s.t >= t0 - 60000);
      if (!pts.length) continue;
      c.strokeStyle = selected && !isSel ? withAlpha(t.color, 0.3) : t.color;
      c.lineWidth = isSel ? 3 : 1.6;
      c.lineJoin = "round";
      c.beginPath();
      let prev: number | null = null;
      for (const s of pts) {
        const px = xOf(s.t), py = yOf(x, s.rssi);
        // break the line on gaps (BSS not seen)
        if (prev === null || s.t - prev > 3 * medianStep(pts)) c.moveTo(px, py);
        else c.lineTo(px, py);
        prev = s.t;
      }
      c.stroke();
      // dots on the last sample
      const last = pts[pts.length - 1];
      c.fillStyle = c.strokeStyle;
      c.beginPath();
      c.arc(xOf(last.t), yOf(x, last.rssi), isSel ? 4 : 2.5, 0, Math.PI * 2);
      c.fill();
      if (isSel) {
        c.fillStyle = x.fg;
        c.textAlign = "right";
        c.textBaseline = "bottom";
        c.fillText(`${ssidLabel(t.info)}  ${last.rssi} dBm`, xOf(last.t) - 6, yOf(x, last.rssi) - 6);
      }
      this.hits.push({
        test: (mx, my) => {
          let best = Infinity;
          for (const s of pts) {
            const dx = xOf(s.t) - mx, dy = yOf(x, s.rssi) - my;
            if (Math.abs(dx) < 30) best = Math.min(best, Math.hypot(dx * 0.3, dy));
          }
          return best < 12 ? best : Infinity;
        },
        hit: { bssid: t.info.bssid, html: `<b>${escapeHtml(ssidLabel(t.info))}</b><br>${t.info.bssid} · ch ${t.info.channel}<br>${t.info.rssiDbm} dBm (min ${t.minRssi} / max ${t.maxRssi})` },
      });
    }
    c.restore();
  }

  // ───────────────────────── Spectrum ─────────────────────────

  private spectrum(band: Band, tracks: Track[], selected: string | null) {
    const x = setup(this.canvas);
    const { c } = x;
    const range = BAND_RANGE[band as "2.4" | "5" | "6"];
    const [f0, f1] = range;
    const iw = x.w - PAD.l - PAD.r;
    const xOf = (f: number) => PAD.l + ((f - f0) / (f1 - f0)) * iw;

    // shaded regions (5 GHz DFS + unused gap)
    if (band === "5") {
      const shade = (a: number, b: number, label: string, alpha: number) => {
        c.fillStyle = withAlpha("hsl(40 90% 55%)", alpha);
        c.fillRect(xOf(a), PAD.t, xOf(b) - xOf(a), x.h - PAD.t - PAD.b);
        c.fillStyle = x.fg3;
        c.textAlign = "center";
        c.textBaseline = "top";
        c.fillText(label, (xOf(a) + xOf(b)) / 2, PAD.t + 2);
      };
      shade(5250, 5330, "W53 (DFS)", 0.07);
      shade(5490, 5730, "W56 (DFS)", 0.07);
      c.fillStyle = x.bg3;
      c.fillRect(xOf(5330), PAD.t, xOf(5490) - xOf(5330), x.h - PAD.t - PAD.b);
    }
    rssiAxis(x);

    // channel ticks
    c.textAlign = "center";
    c.textBaseline = "top";
    for (const ch of CHANNELS[band as "2.4" | "5" | "6"]) {
      const f = chFreq(band, ch);
      const px = xOf(f);
      const major = band === "6" ? (ch - 5) % 16 === 0 : true;
      c.strokeStyle = x.line;
      c.beginPath();
      c.moveTo(px + 0.5, x.h - PAD.b);
      c.lineTo(px + 0.5, x.h - PAD.b + (major ? 5 : 3));
      c.stroke();
      if (major) {
        c.fillStyle = x.fg2;
        c.fillText(String(ch), px, x.h - PAD.b + 7);
      }
    }

    const list = tracks
      .filter((t) => t.info.band === band && !t.hidden)
      .sort((a, b) => Number(a.info.bssid === selected) - Number(b.info.bssid === selected) || a.info.rssiDbm - b.info.rssiDbm);
    const floor = yOf(x, RSSI_MIN);
    c.save();
    c.beginPath();
    c.rect(PAD.l, PAD.t - 4, iw, x.h - PAD.t - PAD.b + 4);
    c.clip();
    for (const t of list) {
      const b = t.info;
      const isSel = b.bssid === selected;
      const lo = xOf(b.freqLowMhz), hi = xOf(b.freqHighMhz);
      const top = yOf(x, b.rssiDbm);
      const slope = Math.min((hi - lo) * 0.12, 10);
      c.beginPath();
      c.moveTo(lo, floor);
      c.bezierCurveTo(lo + slope * 0.6, floor, lo + slope * 0.3, top, lo + slope, top);
      c.lineTo(hi - slope, top);
      c.bezierCurveTo(hi - slope * 0.3, top, hi - slope * 0.6, floor, hi, floor);
      const dim = selected && !isSel;
      c.fillStyle = withAlpha(t.color, isSel ? 0.3 : dim ? 0.04 : 0.12);
      c.fill();
      c.strokeStyle = dim ? withAlpha(t.color, 0.35) : t.color;
      c.lineWidth = isSel ? 2.6 : 1.4;
      c.stroke();
      if (isSel || b.rssiDbm > -78) {
        c.fillStyle = dim ? x.fg3 : x.fg;
        c.textAlign = "center";
        c.textBaseline = "bottom";
        const label = ssidLabel(b);
        const maxW = hi - lo - 4;
        if (c.measureText(label).width <= Math.max(maxW, 120)) c.fillText(label, (lo + hi) / 2, top - 3);
      }
      this.hits.push({
        test: (mx, my) => (mx >= lo && mx <= hi && my >= top - 2 && my <= floor ? my - top : Infinity),
        hit: {
          bssid: b.bssid,
          html: `<b>${escapeHtml(ssidLabel(b))}</b><br>${b.bssid}<br>ch ${b.channel} · ${b.widthMhz} MHz (center ${b.centerChannel})<br>${b.rssiDbm} dBm · ${b.security.label}`,
        },
      });
    }
    c.restore();
  }

  // ───────────────────────── Channel utilization ─────────────────────────

  private load(tracks: Track[]) {
    const x = setup(this.canvas);
    const { c } = x;
    const bands: ("2.4" | "5" | "6")[] = ["2.4", "5", "6"];
    const rowH = (x.h - 8) / 3;
    bands.forEach((band, bi) => {
      const y0 = 4 + bi * rowH;
      const chs = CHANNELS[band].filter((ch) => band !== "6" || (ch - 1) % 4 === 0);
      const data = chs.map((ch) => {
        const f = chFreq(band, ch);
        const over = tracks.filter((t) => t.info.band === band && t.info.freqLowMhz < f + 10 && t.info.freqHighMhz > f - 10);
        const prim = over.filter((t) => t.info.channel === ch);
        const strong = over.filter((t) => t.info.rssiDbm > -70);
        // AP-reported airtime; only nearby BSSs, since a far AP's view says little about this spot
        const util = Math.max(-1, ...strong.map((t) => t.info.bssLoad?.channelUtilizationPct ?? -1));
        return { ch, n: over.length, prim: prim.length, util, strong: strong.length };
      });
      const l = 56, r = 10, bw = (x.w - l - r) / data.length;
      const ih = rowH - 34;
      c.fillStyle = x.fg2;
      c.textAlign = "left";
      c.textBaseline = "top";
      c.font = "600 11px " + getComputedStyle(document.documentElement).getPropertyValue("--sans");
      c.fillText(`${band} GHz`, 6, y0 + 2);
      c.font = "10px " + getComputedStyle(document.documentElement).getPropertyValue("--sans");
      c.fillStyle = x.fg3;
      c.fillText("util %", 6, y0 + 16);
      if (bi === 0) {
        c.textAlign = "right";
        c.fillText("bar = max channel utilization of BSSs above −70 dBm · number = BSS count (grey, no bar = no BSS Load data)", x.w - 10, y0 + 2);
        c.textAlign = "left";
      }
      data.forEach((d, i) => {
        const px = l + i * bw;
        const base = y0 + 14 + ih;
        const bh = d.util >= 0 ? Math.max(1, (d.util / 100) * ih) : 0;
        c.fillStyle = x.bg3;
        c.fillRect(px + 1, y0 + 14, bw - 2, ih);
        c.fillStyle = `hsl(${120 - Math.min(d.util, 100) * 1.2} 75% 50%)`;
        c.fillRect(px + 1, base - bh, bw - 2, bh);
        c.textAlign = "center";
        if (d.n && bw > 12) {
          c.fillStyle = d.util >= 0 ? x.fg : x.fg3;
          c.textBaseline = "bottom";
          c.fillText(String(d.n), px + bw / 2, base - bh - 1);
        }
        const showLabel = band !== "6" ? bw > 16 || i % 2 === 0 : (d.ch - 1) % 16 === 4 || bw > 18;
        if (showLabel) {
          c.fillStyle = x.fg3;
          c.textBaseline = "top";
          c.fillText(String(d.ch), px + bw / 2, base + 3);
        }
        const tip = `<b>${band} GHz ch ${d.ch}</b><br>${
          d.util >= 0 ? `utilization ${d.util.toFixed(0)}% (max of BSSs above −70 dBm)` : "no BSS Load data from BSSs above −70 dBm"
        }<br>${d.n} BSS overlapping (${d.prim} primary)<br>${d.strong} stronger than −70 dBm`;
        this.hits.push({ test: (mx, my) => (mx >= px && mx < px + bw && my >= y0 && my < y0 + rowH ? 0 : Infinity), hit: { bssid: "", html: tip } });
      });
    });
  }
}

function medianStep(pts: { t: number }[]): number {
  if (pts.length < 3) return 10000;
  const d: number[] = [];
  for (let i = 1; i < pts.length; i++) d.push(pts[i].t - pts[i - 1].t);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

const BAND_RANGE = { "2.4": [2398, 2496], "5": [5150, 5895], "6": [5925, 7125] } as const;

const range = (a: number, b: number, s: number) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);

const CHANNELS = {
  "2.4": range(1, 14, 1),
  "5": [...range(36, 64, 4), ...range(100, 144, 4), ...range(149, 177, 4)],
  "6": range(1, 233, 4),
};

function chFreq(band: Band, ch: number): number {
  if (band === "2.4") return ch === 14 ? 2484 : 2407 + ch * 5;
  if (band === "5") return 5000 + ch * 5;
  return 5950 + ch * 5;
}
