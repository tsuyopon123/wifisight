// Run: node src/util.check.ts
import assert from "node:assert/strict";
import type { BssInfo, Track } from "./types";
import { matchFilter, parseFilter } from "./util.ts";

// parsing: OR groups, AND terms, quotes, empty groups, bare "!"
assert.deepEqual(parseFilter(""), []);
assert.deepEqual(parseFilter(" , ,"), []);
assert.deepEqual(parseFilter("ch:36, sec:WPA3 band:6"), [["ch:36"], ["sec:wpa3", "band:6"]]);
assert.deepEqual(parseFilter('ssid:"Free Wi-Fi" !open'), [["ssid:free wi-fi", "!open"]]);
assert.deepEqual(parseFilter('"a,b" ! x'), [["a,b", "x"]]);

const bss = (o: Partial<BssInfo>): Track =>
  ({
    info: {
      ssid: "Free Wi-Fi",
      bssid: "aa:bb:cc:dd:ee:01",
      vendor: "Aruba",
      apName: "hall-1",
      model: null,
      band: "5",
      channel: 36,
      centerChannel: 42,
      widthMhz: 80,
      rssiDbm: -70,
      phyModes: ["a", "n", "ac", "ax"],
      generation: "Wi-Fi 6 (802.11ax)",
      security: { label: "WPA2/WPA3-Personal", akms: ["PSK", "SAE"] },
      ...o,
    },
  }) as unknown as Track;
const a = bss({});
const open = bss({ ssid: "lobby", vendor: null, channel: 1, centerChannel: 1, band: "2.4", widthMhz: 20, rssiDbm: -82, security: { label: "Open", akms: [] } as never });
const f = (q: string) => [a, open].filter((t) => matchFilter(t, q)).map((t) => t.info.ssid);

// unchanged meanings
assert.deepEqual(f(""), ["Free Wi-Fi", "lobby"]);
assert.deepEqual(f("ch:42"), ["Free Wi-Fi"]); // center channel
assert.deepEqual(f("rssi:-75"), ["Free Wi-Fi"]); // at or above
assert.deepEqual(f("ch:1, band:5"), ["Free Wi-Fi", "lobby"]);
assert.deepEqual(f("aruba"), ["Free Wi-Fi"]);
assert.deepEqual(f("foo:bar"), []); // unknown key = free text

// AND, NOT, comparisons (negative numbers are values, not negation)
assert.deepEqual(f("band:5 sec:wpa3"), ["Free Wi-Fi"]);
assert.deepEqual(f("band:5 sec:open"), []);
assert.deepEqual(f("!sec:open"), ["Free Wi-Fi"]);
assert.deepEqual(f("rssi<-75"), ["lobby"]);
assert.deepEqual(f("rssi<=-70"), ["Free Wi-Fi", "lobby"]);
assert.deepEqual(f("rssi>-70"), []);
assert.deepEqual(f("ch>=36 w>=80"), ["Free Wi-Fi"]);
assert.deepEqual(f("width<40"), ["lobby"]);
assert.deepEqual(f("!rssi<-75, ch:1"), ["Free Wi-Fi", "lobby"]);

// keys that only exist on Object.prototype are not numeric keys
assert.deepEqual(f("__proto__<1"), []);
assert.deepEqual(f("tostring>1"), []);

// quotes keep spaces: ssid is an exact match
assert.deepEqual(f('ssid:"free wi-fi"'), ["Free Wi-Fi"]);
assert.deepEqual(f("ssid:free wi-fi"), []); // now two terms: ssid:free AND wi-fi
assert.deepEqual(f('"free wi"'), ["Free Wi-Fi"]);

console.log("util ok");
