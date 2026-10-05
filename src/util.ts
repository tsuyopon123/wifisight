import type { BssInfo, Track } from "./types";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function colorFor(bssid: string): string {
  let h = 2166136261;
  for (let i = 0; i < bssid.length; i++) {
    h ^= bssid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  const light = isLight();
  return `hsl(${hue} ${light ? 70 : 75}% ${light ? 42 : 60}%)`;
}

/** Re-render `root` without losing keyboard focus: refocus the element carrying the same value of one of `attrs`. */
export function keepFocus(root: HTMLElement, attrs: string[], rebuild: () => void) {
  const a = document.activeElement as HTMLElement | null;
  const hit = a && root.contains(a) ? attrs.find((k) => a.hasAttribute(k)) : undefined;
  const val = hit ? a!.getAttribute(hit)! : null;
  rebuild();
  if (hit && val != null) root.querySelector<HTMLElement>(`[${hit}="${CSS.escape(val)}"]`)?.focus();
}

/** Light UI? Settings › Theme wins over the OS setting. */
export function isLight(): boolean {
  const t = document.documentElement.dataset.theme;
  return t ? t !== "dark" : !!window.matchMedia?.("(prefers-color-scheme: light)").matches;
}

export function withAlpha(hsl: string, a: number): string {
  return hsl.replace(/^hsl\((.*)\)$/, `hsl($1 / ${a})`);
}

export function signalColor(rssi: number): string {
  const v = getComputedStyle(document.documentElement);
  const k = rssi >= -60 ? "--good" : rssi >= -67 ? "--ok" : rssi >= -75 ? "--fair" : rssi >= -82 ? "--poor" : "--bad";
  return v.getPropertyValue(k).trim();
}

export function ssidLabel(b: BssInfo): string {
  return b.hidden ? "(hidden)" : b.ssid;
}

export function fmtRate(r: number | null): string {
  if (r == null) return "";
  return r >= 100 ? r.toFixed(0) : r.toFixed(1);
}

export function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

export function isDfs(b: BssInfo): boolean {
  if (b.band !== "5") return false;
  const lo = b.freqLowMhz, hi = b.freqHighMhz;
  return hi > 5250 && lo < 5730;
}

/**
 * Filter: `,` separates OR groups; inside a group, space-separated terms must all match. A term is free text,
 * `key:value`, or a comparison on a number (`rssi<-75`, `ch>=100`, `w>=80`); `!` in front negates it.
 * Double quotes keep spaces in one term (`ssid:"Free Wi-Fi"`).
 */
export function matchFilter(t: Track, query: string): boolean {
  if (parsed.query !== query) parsed = { query, groups: parseFilter(query) }; // called once per BSS per render
  const { groups } = parsed;
  return !groups.length || groups.some((g) => g.every((term) => matchTerm(t.info, term)));
}
let parsed = { query: "", groups: [] as string[][] };

/** Lowercased terms per OR group, quotes removed; empty groups and a bare `!` dropped. */
export function parseFilter(query: string): string[][] {
  const groups: string[][] = [[]];
  let term = "";
  let quoted = false;
  const end = () => {
    if (term && term !== "!") groups[groups.length - 1].push(term);
    term = "";
  };
  for (const c of query.toLowerCase()) {
    if (c === '"') quoted = !quoted;
    else if (quoted) term += c;
    else if (c === ",") {
      end();
      groups.push([]);
    } else if (/\s/.test(c)) end();
    else term += c;
  }
  end();
  return groups.filter((g) => g.length);
}

// a Map, so keys like __proto__ typed into the filter can't reach Object.prototype
const NUMERIC = new Map<string, (b: BssInfo) => number>([
  ["rssi", (b) => b.rssiDbm],
  ["ch", (b) => b.channel],
  ["w", (b) => b.widthMhz],
  ["width", (b) => b.widthMhz],
]);

function matchTerm(b: BssInfo, term: string): boolean {
  if (term.startsWith("!")) return !matchTerm(b, term.slice(1));
  const cmp = term.match(/^(\w+)(<=|>=|<|>)(-?\d+(?:\.\d+)?)$/);
  const num = cmp && NUMERIC.get(cmp[1]);
  if (cmp && num) {
    const x = num(b), v = Number(cmp[3]);
    return { "<": x < v, "<=": x <= v, ">": x > v, ">=": x >= v }[cmp[2]]!;
  }
  const m = term.match(/^(\w+):(.*)$/);
  if (m) {
    const [, k, v] = m;
    switch (k) {
      case "ch":
        return String(b.channel) === v || String(b.centerChannel) === v;
      case "band":
        return b.band === v || b.band === v.replace("ghz", "");
      case "sec":
        return b.security.label.toLowerCase().includes(v) || b.security.akms.some((a) => a.toLowerCase().includes(v));
      case "ssid":
        return b.ssid.toLowerCase() === v;
      case "vendor":
        return (b.vendor ?? "").toLowerCase().includes(v);
      case "ap":
        return (b.apName ?? "").toLowerCase().includes(v);
      case "phy":
        return b.phyModes.includes(v);
      case "w":
      case "width":
        return String(b.widthMhz) === v;
      case "rssi":
        return b.rssiDbm >= Number(v);
    }
  }
  const hay = [b.ssid, b.bssid, b.vendor ?? "", b.apName ?? "", b.model ?? "", b.security.label, b.generation].join(" ").toLowerCase();
  return hay.includes(term);
}

// How the vendor was derived (suffix set by wifi-core) → shown as a tag, like DFS in the Ch column.
const VENDOR_SRC: [RegExp, string, string][] = [
  [/ \(IE\)$/, "IE", "From a vendor-specific IE in the beacon"],
  [/ \(WPS\)$/, "WPS", "From the WPS Manufacturer attribute"],
  [/ \?$/, "guess", "OUI with the locally-administered bit cleared (heuristic)"],
  [/ chipset$/, "chipset", "Only the radio chipset vendor is known"],
];

export function vendorHtml(v: string | null, local: boolean): string {
  if (!v) return local ? "(local)" : "";
  for (const [re, tag, title] of VENDOR_SRC)
    if (re.test(v)) return `${esc(v.replace(re, ""))}<span class="tag r" title="${title}">${tag}</span>`;
  return esc(v);
}
