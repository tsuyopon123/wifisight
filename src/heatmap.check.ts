// Run: node src/heatmap.check.ts
import assert from "node:assert/strict";
import { FLOOR_DBM, apKey, coChannel, estimatePos, idwGrid, layerValue, median, niceLength, secondBest, snrAt } from "./heatmap.ts";

// grouping
assert.equal(apKey("00:11:22:33:44:51", null), apKey("00:11:22:33:44:5f", null));
assert.notEqual(apKey("00:11:22:33:44:51", null), apKey("00:11:22:33:44:61", null));
assert.equal(apKey("00:11:22:33:44:51", "hall-1"), apKey("aa:bb:cc:dd:ee:ff", "hall-1"));

// layer value
assert.equal(layerValue({ a: -70, b: -50 }, ["a", "b"]), -50);
assert.equal(layerValue({ a: -70 }, ["z"]), FLOOR_DBM);

// IDW: exact at samples, between values in the middle, masked far away
const s = [
  { x: 5, y: 5, v: -40 },
  { x: 25, y: 5, v: -80 },
];
const g = idwGrid(s, 100, 1, 10, 30); // cells centred at 5, 15, 25, …
assert.equal(g[0], -40);
assert.equal(g[2], -80);
assert.ok(g[1] > -80 && g[1] < -40);
assert.ok(Number.isNaN(g[99]));

// AP estimate sits next to the strongest point
const p = estimatePos([
  { x: 0, y: 0, v: -40 },
  { x: 100, y: 0, v: -70 },
  { x: 0, y: 100, v: -75 },
  { x: 100, y: 100, v: -85 },
])!;
assert.ok(p.x < 5 && p.y < 5, JSON.stringify(p));
assert.equal(estimatePos([{ x: 1, y: 1, v: FLOOR_DBM }]), null);

assert.equal(median([-60, -50, -70]), -60);
assert.equal(median([-60, -50]), -55);

// 2nd-best AP: BSSIDs of the same AP collapse to one
const key = (b: string) => b[0];
assert.equal(secondBest({ a1: -50, a2: -45, b1: -70, c1: -80 }, ["a1", "a2", "b1", "c1"], key), -70);
assert.equal(secondBest({ a1: -50, a2: -45 }, ["a1", "a2"], key), FLOOR_DBM);

// co-channel: serving a (36/20), b overlaps (36/80), c is another channel, d too weak, a2 same AP
const radios = {
  a: { ap: "A", lo: 5170, hi: 5190 },
  a2: { ap: "A", lo: 5170, hi: 5190 },
  b: { ap: "B", lo: 5170, hi: 5250 },
  c: { ap: "C", lo: 5250, hi: 5270 },
  d: { ap: "D", lo: 5170, hi: 5190 },
};
assert.equal(coChannel({ a: -50, a2: -55, b: -70, c: -60, d: -90 }, ["a"], radios, -82), 1);
assert.equal(coChannel({ c: -60 }, ["a"], radios, -82), null);

assert.equal(snrAt({ a: -50, b: -40 }, { a: -90 }, ["a", "b"]), 40);
assert.equal(snrAt({ a: -50 }, undefined, ["a"]), null);

assert.equal(niceLength(7), 5);
assert.equal(niceLength(19), 10);
assert.equal(niceLength(0.3), 0.2);

console.log("heatmap ok");
