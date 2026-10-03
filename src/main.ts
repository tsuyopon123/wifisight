import * as api from "./api";
import { ChartView, type Tab } from "./charts";
import * as survey from "./survey";
import { detailsText, renderDetails } from "./details";
import { COLUMNS, layout, moveCol, renderBody, renderHead, resetLayout, saveLayout, sortTracks, toCsv, toggleCol, type TableState } from "./table";
import type { Band, Snapshot, Track } from "./types";
import { colorFor, esc, keepFocus, matchFilter } from "./util";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  running: true,
  intervalMs: 0,
  iface: null as string | null,
  probe: null as string | null,
  mode: "scanner" as "scanner" | "survey",
  bands: new Set<Band>(["2.4", "5", "6"]),
  filter: "",
  showHidden: true,
  onlyCurrent: false,
  tab: "signal" as Tab,
  historyMs: 300000,
  tracks: new Map<string, Track>(),
  latestScan: 0,
  scanCount: 0,
  lastInterface: "",
  connLabel: "",
  os: "",
  location: null as string | null,
  lastError: "", // last scan failure, cleared by the next good scan
  table: { sortKey: "rssi", sortAsc: false, selected: null } as TableState,
};

const chart = new ChartView($<HTMLCanvasElement>("chart"));
let timer: number | undefined;
let scanning = false;
let gen = 0; // bumped by clearSession; scans started before it are dropped

function passesFilters(t: Track): boolean {
  return state.bands.has(t.info.band) && (state.showHidden || !t.info.hidden) && matchFilter(t, state.filter);
}

function visibleTracks(): Track[] {
  return [...state.tracks.values()].filter(
    (t) => passesFilters(t) && (!state.onlyCurrent || t.lastSeen >= state.latestScan),
  );
}

function ingest(s: Snapshot) {
  const ts = s.timestampMs;
  // MLO = the OS reports ≥2 connected BSSIDs of one AP MLD (Linux lists every link; macOS/Windows only one)
  const conn = s.bss.filter((b) => b.connected).sort((a, b) => a.freqMhz - b.freqMhz);
  const links = (b: (typeof conn)[0]) => (b.mld ? conn.filter((c) => c.mld === b.mld).length : 1);
  state.connLabel = conn.length
    ? `connected: ${conn[0].ssid} · ${conn.map((b) => `${b.band} GHz ch ${b.channel}`).join(" + ")}${links(conn[0]) > 1 ? " (MLO)" : ""}`
    : "";
  for (const b of s.bss) {
    let t = state.tracks.get(b.bssid);
    if (!t) {
      t = { info: b, color: colorFor(b.bssid), history: [], firstSeen: ts, lastSeen: ts, minRssi: b.rssiDbm, maxRssi: b.rssiDbm, hidden: false };
      state.tracks.set(b.bssid, t);
    }
    t.info = b;
    t.mlo = b.connected && links(b) > 1;
    t.lastSeen = ts;
    t.minRssi = Math.min(t.minRssi, b.rssiDbm);
    t.maxRssi = Math.max(t.maxRssi, b.rssiDbm);
    t.history.push({ t: ts, rssi: b.rssiDbm });
  }
  // keep 60 min of history max
  const cutoff = ts - 3600000;
  for (const t of state.tracks.values()) {
    while (t.history.length && t.history[0].t < cutoff) t.history.shift();
  }
  state.latestScan = ts;
  state.scanCount++;
  state.lastInterface = s.interface;
  $("st-warn").textContent = s.warnings.join(" · ");
  $("st-warn").title = s.warnings.join("\n");
  survey.onSnapshot(s);
}

function render() {
  survey.render();
  const rows = sortTracks(visibleTracks(), state.table);
  const now = Date.now();
  const thead = $("bss-table").querySelector("thead")!;
  keepFocus(thead, ["data-sort"], () => renderHead(thead, state.table));
  renderBody($("bss-table").querySelector("tbody")!, rows, state.table, now, state.latestScan);
  setEmpty(!state.scanCount ? (state.lastError ? "error" : "scanning") : rows.length ? null : state.tracks.size ? "filtered" : "none");
  renderNotice();
  renderChart();
  const sel = state.table.selected ? state.tracks.get(state.table.selected) : undefined;
  $("details").hidden = !sel;
  if (sel) renderDetails($("details"), sel);
  const cur = rows.filter((t) => t.lastSeen >= state.latestScan).length;
  $("st-count").textContent = `${cur} current / ${rows.length} shown / ${state.tracks.size} total BSS`;
  $("st-scan").textContent = state.latestScan
    ? `${state.lastInterface} · scan #${state.scanCount} at ${new Date(state.latestScan).toLocaleTimeString()}${state.running ? "" : " (paused)"}${state.connLabel ? " · " + state.connLabel : ""}`
    : "";
}

const EMPTY = {
  scanning: () => `<p>Scanning…</p>`,
  filtered: () => `<div><p>No BSS matches the current filters.</p><button data-empty="reset" class="primary">Reset filters</button></div>`,
  none: () => `<div><p>No networks found.</p><button data-empty="settings" class="primary">Check probe / interface…</button></div>`,
  error: () => {
    const x = explain(state.lastError);
    return `<div><p class="err-title">${esc(x.title)}</p><p>${esc(x.hint)}</p>${actions(x.act, "data-empty")}<p class="err-raw">${esc(state.lastError)}</p></div>`;
  },
};

type Act = "settings" | "location" | undefined;

const actions = (act: Act, attr: string) =>
  act === "location"
    ? `<div class="acts"><button ${attr}="location" class="primary">Request location access</button><button ${attr}="settings">Settings…</button></div>`
    : act === "settings"
      ? `<div class="acts"><button ${attr}="settings" class="primary">Check probe / interface…</button></div>`
      : "";

/** Turn a backend error into what happened and what to do about it. */
function explain(err: string): { title: string; hint: string; act?: Act } {
  const e = err.toLowerCase();
  if (e.includes("desktop app"))
    return { title: "Scanning needs the desktop app", hint: "This browser preview can't reach Wi-Fi. Run the app (npm run tauri dev) to scan." };
  if (e.includes("probe"))
    return {
      title: `Probe ${state.probe ?? ""} isn't answering`,
      hint: "Check the Ethernet cable and that wifisight-cli serve is running on the Pi — or clear Probe in Settings to use this computer's Wi-Fi.",
      act: "settings",
    };
  if (e.includes("permission")) {
    if (state.os === "macos")
      return { title: "Location access is off", hint: "macOS only lets apps scan Wi-Fi with Location Services on: System Settings › Privacy & Security › Location Services.", act: "location" };
    if (state.os === "windows")
      return { title: "Location access is off", hint: "Windows needs Settings › Privacy & security › Location › “Let desktop apps access your location” to scan Wi-Fi.", act: "settings" };
    return { title: "Scanning isn't permitted", hint: "Active scans need CAP_NET_ADMIN: sudo setcap cap_net_admin+ep <path to wifisight>, or run NetworkManager.", act: "settings" };
  }
  if (e.includes("no wi-fi interface"))
    return { title: "No Wi-Fi interface found", hint: "Turn Wi-Fi on, or pick another interface or a probe in Settings.", act: "settings" };
  return { title: "Scan failed", hint: "Retrying every interval. Check that Wi-Fi is on, or pick another interface / probe in Settings.", act: "settings" };
}

// Only touch the DOM when the content changes, so a focused button keeps focus across scans.
function setEmpty(kind: keyof typeof EMPTY | null) {
  const el = $("empty");
  el.hidden = !kind;
  const html = kind ? EMPTY[kind]() : "";
  if (el.dataset.html !== html) el.innerHTML = html;
  el.dataset.html = html;
}

/** Bar under the toolbar: scans failing after they worked, or location access off (macOS hides SSIDs / BSSIDs). */
function renderNotice() {
  const el = $("notice");
  let html = "";
  if (state.lastError && state.scanCount) {
    const x = explain(state.lastError);
    html = `<p><b>${esc(x.title)}.</b> ${esc(x.hint)} Showing the last good scan.</p>${actions(x.act, "data-notice")}`;
  } else if (state.location === "denied" || state.location === "restricted") {
    html = `<p><b>Location access is off</b> — macOS hides SSIDs and BSSIDs. Turn it on in System Settings › Privacy & Security › Location Services.</p>${actions("location", "data-notice")}`;
  } else if (state.location === "notDetermined") {
    html = `<p><b>Allow location access</b> so macOS shows SSIDs and BSSIDs.</p>${actions("location", "data-notice")}`;
  }
  el.hidden = !html;
  if (el.dataset.html !== html) el.innerHTML = html;
  el.dataset.html = html;
}

function resetFilters() {
  state.filter = "";
  state.showHidden = true;
  state.onlyCurrent = false;
  state.bands = new Set<Band>(["2.4", "5", "6"]);
  $<HTMLInputElement>("filter").value = "";
  $<HTMLInputElement>("chk-hidden").checked = true;
  $<HTMLInputElement>("chk-stale").checked = false;
  document.querySelectorAll<HTMLElement>("#band-filter button").forEach((b) => setOn(b, true));
  render();
}

function setOn(b: Element, on: boolean) {
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
}

function renderChart() {
  chart.draw(state.tab, visibleTracks(), state.table.selected, Date.now(), state.historyMs, state.latestScan);
  $("history-field").style.visibility = state.tab === "signal" ? "visible" : "hidden";
}

async function scanOnce() {
  if (scanning) return;
  scanning = true;
  const t0 = performance.now();
  const g = gen;
  try {
    const s = await api.scan(state.iface, state.probe);
    if (g === gen) {
      state.lastError = "";
      ingest(s);
    }
  } catch (e) {
    if (g === gen) {
      state.lastError = String(e);
      const x = explain(state.lastError);
      $("st-warn").textContent = x.title;
      $("st-warn").title = state.lastError;
      survey.onScanError(x.title);
    }
  } finally {
    scanning = false;
    render();
  }
  if (state.running) {
    const wait = g === gen ? Math.max(300, state.intervalMs - (performance.now() - t0)) : 0;
    timer = window.setTimeout(scanOnce, wait);
  }
}

function setRunning(on: boolean) {
  state.running = on;
  $("btn-run").textContent = on ? "Pause" : "Start";
  window.clearTimeout(timer);
  if (on) scanOnce();
  else render();
}

// ───────────────────────── events ─────────────────────────

function bind() {
  $("btn-run").onclick = () => setRunning(!state.running);
  $<HTMLSelectElement>("sel-interval").onchange = (e) => {
    state.intervalMs = Number((e.target as HTMLSelectElement).value);
    survey.render(); // time per point depends on it
  };
  $<HTMLSelectElement>("sel-history").onchange = (e) => {
    state.historyMs = Number((e.target as HTMLSelectElement).value);
    renderChart();
  };
  $("mode-seg").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-mode]");
    if (b) setMode(b.dataset.mode as typeof state.mode);
  };
  $<HTMLInputElement>("probe").onchange = (e) => {
    state.probe = (e.target as HTMLInputElement).value.trim() || null;
    try {
      localStorage.setItem("wifisight.probe", state.probe ?? "");
    } catch {
      /* per-viewer convenience only */
    }
    state.iface = null;
    loadInterfaces().then(clearSession);
  };
  $<HTMLSelectElement>("sel-iface").onchange = (e) => {
    state.iface = (e.target as HTMLSelectElement).value || null;
    clearSession();
  };
  $("band-filter").onclick = (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    const band = b.dataset.band as Band;
    if (state.bands.has(band)) state.bands.delete(band);
    else state.bands.add(band);
    setOn(b, state.bands.has(band));
    render();
  };
  $<HTMLInputElement>("filter").oninput = (e) => {
    state.filter = (e.target as HTMLInputElement).value;
    render();
  };
  $<HTMLInputElement>("chk-hidden").onchange = (e) => {
    state.showHidden = (e.target as HTMLInputElement).checked;
    render();
  };
  $<HTMLInputElement>("chk-stale").onchange = (e) => {
    state.onlyCurrent = (e.target as HTMLInputElement).checked;
    render();
  };
  const charts = $<HTMLInputElement>("chk-charts");
  const showCharts = (on: boolean) => {
    charts.checked = on;
    $("splitter").hidden = $("bottom").hidden = !on;
    try {
      localStorage.setItem("wifisight.charts", on ? "1" : "0");
    } catch {}
  };
  try {
    showCharts(localStorage.getItem("wifisight.charts") !== "0");
  } catch {}
  charts.onchange = () => showCharts(charts.checked);

  // table: sort / select / toggle visibility
  $("bss-table").onclick = (e) => {
    const target = e.target as HTMLElement;
    const th = target.closest("th");
    if (th) {
      if (resizing || target.closest(".rz")) return;
      const k = th.dataset.sort!;
      if (state.table.sortKey === k) state.table.sortAsc = !state.table.sortAsc;
      else {
        state.table.sortKey = k;
        state.table.sortAsc = ["ssid", "bssid", "vendor", "ap", "band", "ch", "sec", "cc"].includes(k);
      }
      render();
      return;
    }
    const tog = target.closest<HTMLElement>("[data-toggle]");
    if (tog) {
      const t = state.tracks.get(tog.dataset.toggle!);
      if (t) t.hidden = !t.hidden;
      render();
      return;
    }
    const tr = target.closest<HTMLElement>("tr[data-bssid]");
    if (tr) select(tr.dataset.bssid!);
  };

  // table columns: drag header to reorder, drag its right edge to resize, right-click to show/hide
  const thead = $("bss-table").querySelector("thead")!;
  let resizing = false;
  thead.ondragstart = (e) => {
    if (resizing) return e.preventDefault();
    e.dataTransfer!.setData("text/plain", (e.target as HTMLElement).dataset.sort!);
  };
  thead.ondragover = (e) => e.preventDefault();
  thead.ondrop = (e) => {
    e.preventDefault();
    const to = (e.target as HTMLElement).closest("th")?.dataset.sort;
    const from = e.dataTransfer!.getData("text/plain");
    if (to && from && from !== to) {
      moveCol(from, to);
      render();
    }
  };
  thead.onmousedown = (e) => {
    const th = (e.target as HTMLElement).closest(".rz")?.parentElement;
    if (!th) return;
    resizing = true;
    const key = th.dataset.sort!;
    const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const w = Math.max(32, Math.round(w0 + ev.clientX - x0));
      layout.widths[key] = w;
      // patch the live cells instead of a full render; the next render picks up layout.widths
      const head = thead.querySelector<HTMLElement>(`th[data-sort="${key}"]`);
      if (!head) return;
      const i = [...head.parentElement!.children].indexOf(head) + 1;
      for (const el of [head, ...$("bss-table").querySelectorAll<HTMLElement>(`tbody td:nth-child(${i})`)]) {
        el.style.width = el.style.minWidth = el.style.maxWidth = `${w}px`;
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveLayout();
      setTimeout(() => (resizing = false)); // swallow the click that follows mouseup
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  thead.ondblclick = (e) => {
    const key = (e.target as HTMLElement).closest(".rz")?.parentElement?.dataset.sort;
    if (!key) return;
    delete layout.widths[key];
    saveLayout();
    render();
  };
  const colPop = $("col-pop");
  thead.oncontextmenu = (e) => {
    e.preventDefault();
    colPop.innerHTML =
      COLUMNS.map(
        (c) => `<label class="check"><input type="checkbox" data-col="${c.key}"${layout.hidden.includes(c.key) ? "" : " checked"} /> ${c.label}</label>`,
      ).join("") + `<hr /><button data-reset>Reset columns</button>`;
    colPop.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
    colPop.style.top = `${e.clientY}px`;
    colPop.hidden = false;
  };
  colPop.onclick = (e) => {
    e.stopPropagation();
    if (!(e.target as HTMLElement).closest("[data-reset]")) return;
    resetLayout();
    colPop.hidden = true;
    render();
  };
  colPop.onchange = (e) => {
    const cb = e.target as HTMLInputElement;
    toggleCol(cb.dataset.col!);
    cb.checked = !layout.hidden.includes(cb.dataset.col!); // last visible column can't be hidden
    render();
  };
  document.addEventListener("click", () => (colPop.hidden = true));

  // tabs
  $("tabs").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-tab]");
    if (!b) return;
    state.tab = b.dataset.tab as Tab;
    document.querySelectorAll("#tabs button[data-tab]").forEach((x) => setOn(x, x === b));
    renderChart();
  };

  // chart hover / click
  const canvas = $<HTMLCanvasElement>("chart");
  const tip = $("tooltip");
  canvas.onmousemove = (e) => {
    const h = chart.hitTest(e.offsetX, e.offsetY);
    if (!h) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = h.html;
    tip.hidden = false;
    const w = canvas.clientWidth;
    tip.style.left = `${Math.min(e.offsetX + 14, w - tip.offsetWidth - 6)}px`;
    tip.style.top = `${Math.max(4, e.offsetY - tip.offsetHeight - 10)}px`;
  };
  canvas.onmouseleave = () => (tip.hidden = true);
  canvas.onclick = (e) => {
    const h = chart.hitTest(e.offsetX, e.offsetY);
    if (h?.bssid) select(h.bssid, true);
  };
  new ResizeObserver(() => renderChart()).observe(canvas.parentElement!);

  // splitter
  const main = $("main");
  $("splitter").onpointerdown = (e) => {
    e.preventDefault(); // no text selection while dragging
    const el = e.target as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const rect = main.getBoundingClientRect();
    el.onpointermove = (ev) => {
      const pct = Math.min(85, Math.max(15, ((ev.clientY - rect.top) / rect.height) * 100));
      main.style.setProperty("--top", `${pct}%`);
    };
    el.onpointerup = () => (el.onpointermove = null);
  };

  // menu
  const pop = $("menu-pop");
  $("btn-menu").onclick = (e) => {
    e.stopPropagation();
    setMenu(pop.hidden);
  };
  const setMenu = (open: boolean) => {
    pop.hidden = !open;
    $("btn-menu").setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("click", () => setMenu(false));
  $("empty").onclick = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-empty]")?.dataset.empty;
    if (act === "reset") resetFilters();
    else if (act === "settings") $("btn-settings").click();
    else if (act === "location") requestLocation();
  };
  $("notice").onclick = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-notice]")?.dataset.notice;
    if (act === "settings") $("btn-settings").click();
    else if (act === "location") requestLocation();
  };
  // the macOS prompt / System Settings answer arrives asynchronously and doesn't reliably fire `focus`, so poll until granted
  window.setInterval(async () => {
    if (state.location == null || state.location === "authorized") return;
    state.location = (await api.platformInfo()).locationStatus;
    renderNotice();
  }, 1000);
  $("btn-help").onclick = () => $<HTMLDialogElement>("dlg-help").showModal();
  const theme = $<HTMLSelectElement>("sel-theme");
  theme.value = document.documentElement.dataset.theme ?? "";
  theme.onchange = () => setTheme(theme.value);
  // "Follow system": CSS switches by itself; BSS colours are computed per theme, so redo them
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (document.documentElement.dataset.theme) return;
    for (const tr of state.tracks.values()) tr.color = colorFor(tr.info.bssid);
    render();
  });
  $("btn-csv").onclick = async () => {
    const rows = sortTracks(visibleTracks(), state.table);
    await api.saveFile(`wifisight-${stamp()}.csv`, toCsv(rows), "csv");
  };
  $("btn-json").onclick = async () => {
    const data = {
      app: "wifisight",
      exportedAt: new Date().toISOString(),
      interface: state.lastInterface,
      tracks: [...state.tracks.values()].map((t) => ({
        firstSeen: t.firstSeen,
        lastSeen: t.lastSeen,
        info: t.info,
        history: t.history.map((s) => [s.t, s.rssi]),
      })),
    };
    await api.saveFile(`wifisight-${stamp()}.json`, JSON.stringify(data), "json");
  };
  $("btn-settings").onclick = () => $<HTMLDialogElement>("dlg-settings").showModal();
  $("btn-oui").onclick = async () => {
    const st = $("oui-status");
    st.textContent = "Downloading IEEE OUI registry…";
    try {
      const n = await api.updateOui();
      st.textContent = `Loaded ${n.toLocaleString()} OUIs. Applies from the next scan.`;
    } catch (e) {
      st.textContent = String(e);
    }
  };
  $("btn-loc").onclick = () => requestLocation();
  $("details").addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const act = btn?.dataset.act;
    const t = state.table.selected ? state.tracks.get(state.table.selected) : undefined;
    if (act === "copy") {
      await navigator.clipboard.writeText(detailsText($("details")));
      btn!.textContent = "Copied";
      setTimeout(() => (btn!.textContent = "Copy text"), 1500);
    } else if (act === "close") {
      select(null);
    } else if (act === "json" && t) {
      const name = `bss-${t.info.bssid.replace(/:/g, "")}-${stamp()}.json`;
      await api.saveFile(name, JSON.stringify({ firstSeen: t.firstSeen, lastSeen: t.lastSeen, info: t.info, history: t.history.map((s) => [s.t, s.rssi]) }, null, 2), "json");
    }
  });
  const dlg = $<HTMLDialogElement>("dlg-clear");
  $("btn-clear").onclick = () => dlg.showModal();
  dlg.onclose = () => dlg.returnValue === "ok" && clearSession();

  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (document.querySelector("dialog[open]")) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === "1" || e.key === "2")) {
      e.preventDefault();
      return setMode(e.key === "1" ? "scanner" : "survey");
    }
    if (t.matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    // sortable headers, survey rows: Enter / Space act like a click
    if ((e.key === "Enter" || e.key === " ") && t.matches("[data-kbd]")) {
      e.preventDefault();
      return t.click();
    }
    if (e.key === " ") {
      if (t.matches("button, summary, a")) return; // let a focused button take its own Space
      e.preventDefault();
      return setRunning(!state.running);
    }
    if (e.key === "?") return $("btn-help").click();
    if (state.mode !== "scanner") return;
    if (e.key === "v") {
      const sel = state.table.selected ? state.tracks.get(state.table.selected) : undefined;
      if (sel) {
        sel.hidden = !sel.hidden;
        render();
      }
    } else if (e.key === "Escape") {
      if (!pop.hidden) setMenu(false);
      else select(null);
    }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = sortTracks(visibleTracks(), state.table);
      const i = rows.findIndex((t) => t.info.bssid === state.table.selected);
      const n = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[n]) select(rows[n].info.bssid, true);
    } else if (["1", "2", "3", "4", "5"].includes(e.key)) {
      (document.querySelectorAll<HTMLElement>("#tabs button[data-tab]")[Number(e.key) - 1])?.click();
    }
  });
}

function setMode(mode: typeof state.mode) {
  state.mode = mode;
  document.querySelectorAll<HTMLElement>("#mode-seg button").forEach((x) => setOn(x, x.dataset.mode === mode));
  document.body.classList.toggle("mode-survey", mode === "survey");
  $("main").hidden = mode !== "scanner";
  $("survey").hidden = mode !== "survey";
  survey.setActive(mode === "survey");
  if (mode === "scanner") render();
}

const THEMES = ["", "dark", "light"]; // "" = follow the OS

function applyTheme(t: string) {
  if (!THEMES.includes(t)) t = ""; // e.g. a theme saved by an older version
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function setTheme(t: string) {
  applyTheme(t);
  $<HTMLSelectElement>("sel-theme").value = t;
  try {
    localStorage.setItem("wifisight.theme", t);
  } catch {
    /* per-viewer convenience only */
  }
  for (const tr of state.tracks.values()) tr.color = colorFor(tr.info.bssid);
  render();
}


async function requestLocation() {
  await api.requestLocation();
  state.location = (await api.platformInfo()).locationStatus;
  renderNotice();
  $("btn-run").title = state.running && state.lastError ? "Scanning, but every scan is failing — see the message above (Space pauses)" : "Start / pause scanning (Space)";
}

function select(bssid: string | null, scroll = false) {
  state.table.selected = state.table.selected === bssid && !scroll ? null : bssid;
  render();
  if (scroll && bssid) document.querySelector(`tr[data-bssid="${bssid}"]`)?.scrollIntoView({ block: "nearest" });
}

function clearSession() {
  state.tracks.clear();
  state.latestScan = 0;
  state.scanCount = 0;
  state.table.selected = null;
  state.lastInterface = "";
  state.connLabel = "";
  state.lastError = "";
  $("st-warn").textContent = "";
  gen++;
  window.clearTimeout(timer);
  if (state.running) scanOnce();
  else render();
}

async function loadInterfaces() {
  try {
    const ifs = await api.listInterfaces(state.probe);
    $("sel-iface").innerHTML =
      `<option value="">(default)</option>` + ifs.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}${i.mac ? " — " + esc(i.mac) : ""}</option>`).join("");
  } catch (e) {
    $("sel-iface").innerHTML = `<option value="">${api.isTauri ? "(none found)" : "(desktop app only)"}</option>`;
    $("st-warn").textContent = explain(String(e)).title;
    $("st-warn").title = String(e);
  }
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function init() {
  bind();
  const info = await api.platformInfo();
  state.os = info.os;
  state.location = info.locationStatus;
  const loc = info.locationStatus ? ` · location: ${info.locationStatus}` : "";
  $("st-platform").textContent = `${info.os}${info.arch ? "/" + info.arch : ""} · v${info.version}${loc}`;
  $("oui-status").textContent = info.ouiEntries ? `${info.ouiEntries.toLocaleString()} OUIs loaded.` : "Not loaded.";
  document.querySelectorAll<HTMLElement>(".loc-row").forEach((el) => (el.hidden = !info.locationStatus));
  if (api.isTauri && !info.ouiEntries) $("btn-oui").click(); // first run: fetch vendor DB without making the user hunt for it
  const probeInput = $<HTMLInputElement>("probe");
  probeInput.disabled = !api.isTauri;
  try {
    state.probe = (api.isTauri && localStorage.getItem("wifisight.probe")) || null;
  } catch {
    state.probe = null;
  }
  probeInput.value = state.probe ?? "";
  await loadInterfaces();
  await survey.init({
    visible: (b) => passesFilters({ info: b } as Track),
    ensureRunning: () => {
      const inFlight = scanning; // a scan started before the click doesn't belong to the new spot
      if (!state.running) setRunning(true);
      return inFlight;
    },
    running: () => state.running,
    intervalMs: () => state.intervalMs,
    status: (msg) => ($("st-warn").textContent = msg),
  });
  render();
  scanOnce();
  // refresh "last seen" ages and the time axis between scans
  setInterval(() => {
    if (state.tab === "signal") renderChart();
  }, 1000);
}

try {
  applyTheme(localStorage.getItem("wifisight.theme") ?? "");
} catch {
  /* follow the OS */
}
init();
