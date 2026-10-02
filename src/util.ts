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

/** Filter: comma separated OR terms; each term is free text or key:value. */
export function matchFilter(t: Track, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const b = t.info;
  return q
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((term) => {
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
    });
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
