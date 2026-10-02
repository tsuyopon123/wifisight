// Pure survey math (no DOM): AP grouping, IDW interpolation, AP position estimate.
// Self-check: `node src/heatmap.check.ts`.

/** Value used where a measured point did not hear the layer at all. */
// ponytail: fixed floor; "not heard" ≈ below sensitivity. Make it per-device if probes differ a lot.
export const FLOOR_DBM = -95;

export interface Sample {
  x: number;
  y: number;
  v: number;
}

/**
 * Group BSSIDs that belong to the same physical AP: the AP name (Cisco CCX / Aruba / UniFi IE) when present,
 * otherwise the BSSID with the low nibble of the last octet masked.
 */
// ponytail: multi-BSSID numbering differs per vendor; if this merges/splits wrongly, look at BSSID layers.
export function apKey(bssid: string, apName: string | null): string {
  if (apName) return `name:${apName}`;
  return `mac:${bssid.toLowerCase().slice(0, 16)}x`;
}

/** Strongest RSSI among `bssids` at one point, or FLOOR_DBM if none were heard. */
export function layerValue(rssi: Record<string, number>, bssids: Iterable<string>): number {
  let v = FLOOR_DBM;
  for (const b of bssids) if (rssi[b] != null && rssi[b] > v) v = rssi[b];
  return v;
}

/**
 * Inverse-distance-weighted (power 2) grid in dBm. `NaN` where the nearest sample is farther than `maxDist`.
 * Cell (i, j) is sampled at its centre ((i + 0.5) * cell, (j + 0.5) * cell).
 */
export function idwGrid(samples: Sample[], cols: number, rows: number, cell: number, maxDist: number): Float32Array {
  const out = new Float32Array(cols * rows).fill(NaN);
  const max2 = maxDist * maxDist;
  for (let j = 0; j < rows; j++) {
    const y = (j + 0.5) * cell;
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * cell;
      let num = 0,
        den = 0,
        near = Infinity,
        exact = NaN;
      for (const s of samples) {
        const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d2 < near) near = d2;
        if (d2 < 1e-6) exact = s.v;
        num += s.v / d2;
        den += 1 / d2;
      }
      if (near > max2) continue;
      out[j * cols + i] = Number.isNaN(exact) ? num / den : exact;
    }
  }
  return out;
}

/** Estimated transmitter position: centroid of the 3 strongest samples, weighted in mW. */
export function estimatePos(samples: Sample[]): { x: number; y: number } | null {
  const top = samples
    .filter((s) => s.v > FLOOR_DBM)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3);
  if (!top.length) return null;
  let x = 0,
    y = 0,
    w = 0;
  for (const s of top) {
    const mw = 10 ** (s.v / 10);
    x += s.x * mw;
    y += s.y * mw;
    w += mw;
  }
  return { x: x / w, y: y / w };
}

/** Strongest RSSI of the 2nd-best AP (BSSIDs grouped by `keyOf`), or FLOOR_DBM if fewer than 2 APs were heard. */
export function secondBest(rssi: Record<string, number>, bssids: Iterable<string>, keyOf: (bssid: string) => string): number {
  const best = new Map<string, number>();
  for (const b of bssids) {
    const v = rssi[b];
    if (v == null) continue;
    const k = keyOf(b);
    const cur = best.get(k);
    if (cur == null || v > cur) best.set(k, v);
  }
  return [...best.values()].sort((a, b) => b - a)[1] ?? FLOOR_DBM;
}

export interface Radio {
  ap: string;
  lo: number; // occupied MHz
  hi: number;
}

/**
 * Number of other APs heard at ≥ minDbm whose occupied channel overlaps the serving BSS
 * (the strongest of `serving`). Every BSS in `rssi` counts as a possible interferer. null if nothing was heard.
 */
export function coChannel(rssi: Record<string, number>, serving: Iterable<string>, radios: Record<string, Radio>, minDbm: number): number | null {
  let top: string | null = null;
  for (const b of serving) if (rssi[b] != null && radios[b] && (top == null || rssi[b] > rssi[top])) top = b;
  if (top == null) return null;
  const s = radios[top];
  const aps = new Set<string>();
  for (const [b, v] of Object.entries(rssi)) {
    const r = radios[b];
    if (r && v >= minDbm && r.ap !== s.ap && r.lo < s.hi && r.hi > s.lo) aps.add(r.ap);
  }
  return aps.size;
}

/** SNR of the strongest BSS among `bssids` that has a noise reading, or null. */
export function snrAt(rssi: Record<string, number>, noise: Record<string, number> | undefined, bssids: Iterable<string>): number | null {
  let best = -Infinity,
    snr: number | null = null;
  for (const b of bssids) {
    if (rssi[b] == null || noise?.[b] == null || rssi[b] <= best) continue;
    best = rssi[b];
    snr = rssi[b] - noise[b];
  }
  return snr;
}

/** Largest 1 / 2 / 5 × 10ⁿ that is ≤ max (for a scale bar). */
export function niceLength(max: number): number {
  const p = 10 ** Math.floor(Math.log10(max));
  return [5, 2, 1].map((m) => m * p).find((v) => v <= max)!;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
