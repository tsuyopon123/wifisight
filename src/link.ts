import type { LinkEvent, LinkInfo } from "./types";

/** The change between two link polls, or null when the AP stayed the same. */
export function linkChange(prev: LinkInfo | null, next: LinkInfo | null, t: number): LinkEvent | null {
  if ((prev?.bssid ?? null) === (next?.bssid ?? null)) return null;
  return {
    t,
    from: prev?.bssid ?? null,
    to: next?.bssid ?? null,
    rssiBefore: prev?.rssiDbm ?? null,
    rssiAfter: next?.rssiDbm ?? null,
    txBefore: prev?.txMbps ?? null,
    txAfter: next?.txMbps ?? null,
  };
}

export const eventKind = (e: LinkEvent) => (!e.from ? "connect" : !e.to ? "disconnect" : "roam");

/** "tx 866 / rx 780 Mbps · MCS 11×2", only the parts the OS reported. */
export function linkText(l: LinkInfo): string {
  const r = (v: number) => Math.round(v);
  const rate =
    l.txMbps != null && l.rxMbps != null
      ? `tx ${r(l.txMbps)} / rx ${r(l.rxMbps)} Mbps`
      : l.txMbps != null
        ? `tx ${r(l.txMbps)} Mbps`
        : l.rxMbps != null
          ? `rx ${r(l.rxMbps)} Mbps`
          : "";
  const mcs = l.mcs != null ? `MCS ${l.mcs}${l.nss ? `×${l.nss}` : ""}` : "";
  return [rate, mcs].filter(Boolean).join(" · ");
}

/** Gap between a disconnect and the connect that follows it, keyed by the connect event. */
export function gaps(events: LinkEvent[]): Map<LinkEvent, number> {
  const m = new Map<LinkEvent, number>();
  events.forEach((e, i) => {
    const p = events[i - 1];
    if (!e.from && p && !p.to) m.set(e, e.t - p.t);
  });
  return m;
}

export function eventsCsv(events: LinkEvent[], name: (bssid: string | null) => string): string {
  const q = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const gap = gaps(events);
  const head = "time,kind,from,from_name,to,to_name,rssi_before,rssi_after,tx_before_mbps,tx_after_mbps,gap_ms";
  const rows = events.map((e) =>
    [new Date(e.t).toISOString(), eventKind(e), e.from, e.from && name(e.from), e.to, e.to && name(e.to), e.rssiBefore, e.rssiAfter, e.txBefore, e.txAfter, gap.get(e)]
      .map(q)
      .join(","),
  );
  return [head, ...rows].join("\n") + "\n";
}
