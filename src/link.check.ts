// Run: node src/link.check.ts
import assert from "node:assert/strict";
import type { LinkInfo } from "./types";
import { eventKind, eventsCsv, gaps, linkChange, linkText } from "./link.ts";

const l = (bssid: string, o: Partial<LinkInfo> = {}): LinkInfo => ({ bssid, ssid: null, rssiDbm: -60, txMbps: 866.7, rxMbps: null, mcs: null, nss: null, ...o });

// same AP (rate changes don't count), roam, disconnect, connect
assert.equal(linkChange(l("a"), l("a", { txMbps: 1 }), 1), null);
assert.equal(linkChange(null, null, 1), null);
const roam = linkChange(l("a", { rssiDbm: -78 }), l("b", { rssiDbm: -50, txMbps: 1200 }), 10)!;
assert.deepEqual(roam, { t: 10, from: "a", to: "b", rssiBefore: -78, rssiAfter: -50, txBefore: 866.7, txAfter: 1200 });
const down = linkChange(l("b"), null, 20)!;
const up = linkChange(null, l("c"), 23500)!;
assert.deepEqual([roam, down, up].map(eventKind), ["roam", "disconnect", "connect"]);

// gap = disconnect → next connect only
const g = gaps([roam, down, up]);
assert.equal(g.get(up), 23480);
assert.equal(g.size, 1);

// status text shows only what the OS reported
assert.equal(linkText(l("a")), "tx 867 Mbps");
assert.equal(linkText(l("a", { rxMbps: 780, mcs: 11, nss: 2 })), "tx 867 / rx 780 Mbps · MCS 11×2");
assert.equal(linkText(l("a", { txMbps: null })), "");

// CSV: header + one row per event, names quoted when needed
const csv = eventsCsv([roam, down, up], (b) => (b === "a" ? "hall, east" : b!)).trim().split("\n");
assert.equal(csv.length, 4);
assert.match(csv[1], /,roam,a,"hall, east",b,b,-78,-50,866.7,1200,$/);
assert.match(csv[3], /,connect,,,c,c,,-60,,866.7,23480$/);
