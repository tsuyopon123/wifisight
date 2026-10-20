import type { Track } from "./types";
import { csvCell, esc, fmtAgo, fmtRate, isDfs, load, openColumnPicker, save, signalColor, ssidLabel, vendorHtml } from "./util";

interface Col {
  key: string;
  label: string;
  num?: boolean;
  mono?: boolean;
  title?: string;
  sort: (t: Track) => number | string;
  html: (t: Track, now: number) => string;
  text: (t: Track) => string | number;
}

const loadPct = (t: Track) => t.info.bssLoad?.channelUtilizationPct ?? -1;

export const COLUMNS: Col[] = [
  {
    key: "ssid",
    label: "SSID",
    sort: (t) => ssidLabel(t.info).toLowerCase(),
    html: (t) =>
      `<button class="swatch${t.hidden ? " off" : ""}" data-toggle="${t.info.bssid}" tabindex="-1" style="color:${t.color};background:${t.color}" aria-label="${t.hidden ? "Show in" : "Hide from"} charts (V)" title="${t.hidden ? "Show in" : "Hide from"} charts (V)"></button> ` +
      (t.info.hidden ? `<span class="hidden-ssid">(hidden)</span>` : esc(t.info.ssid)) +
      (t.mlo
        ? `<span class="conn" title="Connected via MLO · link ${t.info.mldLinkId ?? "?"} of AP MLD ${t.info.mld}">● MLO</span>`
        : t.info.connected
          ? `<span class="conn" title="Connected">●</span>`
          : ""),
    text: (t) => t.info.ssid,
  },
  { key: "bssid", label: "BSSID", mono: true, sort: (t) => t.info.bssid, html: (t) => t.info.bssid, text: (t) => t.info.bssid },
  {
    key: "vendor",
    label: "Vendor",
    sort: (t) => (t.info.vendor ?? "~").toLowerCase(),
    html: (t) => vendorHtml(t.info.vendor, t.info.locallyAdministered),
    text: (t) => t.info.vendor ?? "",
  },
  { key: "ap", label: "AP Name", sort: (t) => (t.info.apName ?? "~").toLowerCase(), html: (t) => esc(t.info.apName ?? ""), text: (t) => t.info.apName ?? "" },
  { key: "band", label: "Band", num: true, sort: (t) => t.info.freqMhz, html: (t) => t.info.band, text: (t) => t.info.band },
  {
    key: "ch",
    label: "Ch",
    num: true,
    sort: (t) => t.info.freqMhz,
    html: (t) => `${isDfs(t.info) ? '<span class="tag dfs" title="DFS">DFS</span>' : ""}${t.info.channel}`,
    text: (t) => t.info.channel,
  },
  {
    key: "width",
    label: "Width",
    num: true,
    title: "Channel width (center channel)",
    sort: (t) => t.info.widthMhz,
    html: (t) => (t.info.widthMhz > 20 ? `${t.info.widthMhz} <span style="color:var(--fg-3)">(${t.info.centerChannel})</span>` : "20"),
    text: (t) => t.info.widthMhz,
  },
  {
    key: "rssi",
    label: "Signal",
    num: true,
    sort: (t) => t.info.rssiDbm,
    html: (t) => {
      const pct = Math.max(0, Math.min(100, ((t.info.rssiDbm + 100) / 70) * 100));
      return `<span class="bar">${t.info.rssiDbm}<span><i style="width:${pct}%;background:${signalColor(t.info.rssiDbm)}"></i></span></span>`;
    },
    text: (t) => t.info.rssiDbm,
  },
  { key: "noise", label: "Noise", num: true, sort: (t) => t.info.noiseDbm ?? -999, html: (t) => String(t.info.noiseDbm ?? ""), text: (t) => t.info.noiseDbm ?? "" },
  { key: "snr", label: "SNR", num: true, sort: (t) => t.info.snrDb ?? -999, html: (t) => String(t.info.snrDb ?? ""), text: (t) => t.info.snrDb ?? "" },
  {
    key: "sec",
    label: "Security",
    sort: (t) => t.info.security.label,
    html: (t) => {
      const l = t.info.security.label;
      const cls = /WPA3|OWE/.test(l) && !/WPA2\//.test(l) ? "w3" : /^Open|WEP/.test(l) ? "open" : "";
      return `<span class="tag ${cls}">${esc(l)}</span>`;
    },
    text: (t) => t.info.security.label,
  },
  { key: "gen", label: "Gen", title: "Wi-Fi generation", sort: (t) => t.info.generation, html: (t) => t.info.generation.replace(/ \(.*\)$/, ""), text: (t) => t.info.generation },
  { key: "phy", label: "PHY", sort: (t) => t.info.generation, html: (t) => t.info.phyModes.join("/"), text: (t) => t.info.phyModes.join("/") },
  { key: "nss", label: "NSS", num: true, sort: (t) => t.info.spatialStreams ?? 0, html: (t) => String(t.info.spatialStreams ?? ""), text: (t) => t.info.spatialStreams ?? "" },
  { key: "rate", label: "Max Rate", num: true, title: "Max PHY rate (Mbps)", sort: (t) => t.info.maxRateMbps ?? 0, html: (t) => fmtRate(t.info.maxRateMbps), text: (t) => t.info.maxRateMbps ?? "" },
  {
    key: "sta",
    label: "Clients",
    num: true,
    title: "Station count (BSS Load element)",
    sort: (t) => t.info.bssLoad?.stationCount ?? -1,
    html: (t) => String(t.info.bssLoad?.stationCount ?? ""),
    text: (t) => t.info.bssLoad?.stationCount ?? "",
  },
  {
    key: "util",
    label: "Ch Util",
    num: true,
    title: "Channel utilization reported by the AP (BSS Load element)",
    sort: loadPct,
    html: (t) => (t.info.bssLoad ? `${t.info.bssLoad.channelUtilizationPct.toFixed(0)}%` : ""),
    text: (t) => t.info.bssLoad?.channelUtilizationPct ?? "",
  },
  {
    key: "kvr",
    label: "k/v/r",
    title: "802.11k / 802.11v / 802.11r",
    sort: (t) => Number(t.info.features.rrm11k) + Number(t.info.features.bssTransition11v) + Number(t.info.features.ft11r),
    html: (t) => {
      const f = t.info.features;
      return [f.rrm11k ? "k" : "·", f.bssTransition11v ? "v" : "·", f.ft11r ? "r" : "·"].join("");
    },
    text: (t) => [t.info.features.rrm11k ? "k" : "", t.info.features.bssTransition11v ? "v" : "", t.info.features.ft11r ? "r" : ""].join(""),
  },
  { key: "cc", label: "CC", title: "Country code", sort: (t) => t.info.country ?? "", html: (t) => t.info.country ?? "", text: (t) => t.info.country ?? "" },
  {
    key: "seen",
    label: "Last Seen",
    num: true,
    sort: (t) => -t.lastSeen,
    html: (t, now) => fmtAgo(now - t.lastSeen),
    text: (t) => new Date(t.lastSeen).toISOString(),
  },
];

// column layout (order / hidden / widths), persisted per machine
interface Layout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}
const LS_KEY = "wifisight.columns";
const defaults = (): Layout => ({ order: COLUMNS.map((c) => c.key), hidden: [], widths: {} });

export const layout: Layout = (() => {
  const d = defaults();
  try {
    const s = JSON.parse(load(LS_KEY) ?? "null") as Layout | null;
    if (!s) return d;
    // drop unknown keys, append columns added since the layout was saved
    const order = s.order.filter((k) => d.order.includes(k));
    return { order: [...order, ...d.order.filter((k) => !order.includes(k))], hidden: s.hidden ?? [], widths: s.widths ?? {} };
  } catch {
    return d;
  }
})();

function saveLayout() {
  save(LS_KEY, JSON.stringify(layout));
}

function resetLayout() {
  Object.assign(layout, defaults());
  saveLayout();
}

function visibleCols(): Col[] {
  return layout.order.filter((k) => !layout.hidden.includes(k)).map((k) => COLUMNS.find((c) => c.key === k)!);
}

function toggleCol(key: string) {
  const h = layout.hidden;
  if (h.includes(key)) h.splice(h.indexOf(key), 1);
  else if (visibleCols().length > 1) h.push(key);
  saveLayout();
}

/** Move `from` to `to`'s position (after it when moving right, before it when moving left). */
function moveCol(from: string, to: string) {
  const o = layout.order;
  const right = o.indexOf(from) < o.indexOf(to);
  o.splice(o.indexOf(from), 1);
  o.splice(o.indexOf(to) + (right ? 1 : 0), 0, from);
  saveLayout();
}

const widthStyle = (c: Col) => {
  const w = layout.widths[c.key];
  return w ? ` style="width:${w}px;min-width:${w}px;max-width:${w}px"` : "";
};

export interface TableState {
  sortKey: string;
  sortAsc: boolean;
  selected: string | null;
}

export function renderHead(thead: HTMLElement, st: TableState) {
  thead.innerHTML =
    "<tr>" +
    visibleCols().map(
      (c) =>
        `<th data-sort="${c.key}" data-kbd tabindex="0" draggable="true" class="${c.num ? "num" : ""}"${widthStyle(c)} title="${esc(c.title ?? c.label)}"${
          st.sortKey === c.key ? ` aria-sort="${st.sortAsc ? "ascending" : "descending"}"` : ""
        }>${c.label}${
          st.sortKey === c.key ? `<span class="arrow">${st.sortAsc ? "▲" : "▼"}</span>` : ""
        }<span class="rz"></span></th>`,
    ).join("") +
    "</tr>";
}

export function sortTracks(list: Track[], st: TableState): Track[] {
  const col = COLUMNS.find((c) => c.key === st.sortKey) ?? COLUMNS[0];
  const dir = st.sortAsc ? 1 : -1;
  return list.slice().sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    if (x < y) return -dir;
    if (x > y) return dir;
    return b.info.rssiDbm - a.info.rssiDbm;
  });
}

export function renderBody(tbody: HTMLElement, rows: Track[], st: TableState, now: number, latestScan: number) {
  const cols = visibleCols();
  tbody.innerHTML = rows
    .map((t) => {
      const cls = [t.info.bssid === st.selected ? "sel" : "", t.lastSeen < latestScan ? "stale" : ""].join(" ");
      return (
        `<tr data-bssid="${t.info.bssid}" class="${cls}">` +
        cols.map((c) => `<td class="${c.num ? "num" : ""} ${c.mono ? "mono" : ""}"${widthStyle(c)}>${c.html(t, now)}</td>`).join("") +
        "</tr>"
      );
    })
    .join("");
}

export function toCsv(rows: Track[]): string {
  const q = csvCell;
  const extra = ["freq_mhz", "center_freq_mhz", "min_rssi", "max_rssi", "akm", "pairwise", "pmf", "generation", "rcoi", "first_seen"];
  const cols = visibleCols();
  const head = [...cols.map((c) => c.label), ...extra].map(q).join(",");
  const lines = rows.map((t) =>
    [
      ...cols.map((c) => c.text(t)),
      t.info.freqMhz,
      t.info.centerFreqMhz,
      t.minRssi,
      t.maxRssi,
      t.info.security.akms.join(" "),
      t.info.security.pairwise.join(" "),
      t.info.security.pmf,
      t.info.generation,
      t.info.roamingConsortium.join(" "),
      new Date(t.firstSeen).toISOString(),
    ]
      .map(q)
      .join(","),
  );
  return [head, ...lines].join("\n") + "\n";
}

/**
 * Column layout by mouse on the table head: drag a header to reorder, drag its right edge to resize
 * (double-click it to reset), right-click for the show/hide popover. Returns "a resize is in progress",
 * so the caller's header click (sort) can ignore the click that ends a resize.
 */
export function bindColumns(table: HTMLElement, pop: HTMLElement, onChange: () => void): () => boolean {
  const thead = table.querySelector("thead")!;
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
      onChange();
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
      for (const el of [head, ...table.querySelectorAll<HTMLElement>(`tbody td:nth-child(${i})`)]) {
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
    onChange();
  };
  thead.oncontextmenu = (e) => {
    e.preventDefault();
    openColumnPicker(pop, COLUMNS, layout.hidden, e.clientX, e.clientY, `<hr /><button data-reset>Reset columns</button>`);
  };
  pop.onclick = (e) => {
    e.stopPropagation();
    if (!(e.target as HTMLElement).closest("[data-reset]")) return;
    resetLayout();
    pop.hidden = true;
    onChange();
  };
  pop.onchange = (e) => {
    const cb = e.target as HTMLInputElement;
    toggleCol(cb.dataset.col!);
    cb.checked = !layout.hidden.includes(cb.dataset.col!); // last visible column can't be hidden
    onChange();
  };
  document.addEventListener("click", () => (pop.hidden = true));
  return () => resizing;
}
