// Run: node src/errors.check.ts
import assert from "node:assert/strict";
import { explain } from "./errors.ts";

const t = (err: string, probe = "", os = "linux") => explain(err, probe, os, false).title;

// probe: no connection / scan failed there / not a probe at all
assert.equal(t("probe 10.0.0.2:8737 unreachable: Connection refused", "10.0.0.2:8737"), "Can't reach probe 10.0.0.2:8737");
assert.equal(t("probe p: HTTP 500: Scan trigger needs CAP_NET_ADMIN", "p"), "Probe p can't scan");
assert.equal(t("probe p: bad response: expected value", "p"), "p isn't a WiFiSight probe");
// local: permission depends on the OS
assert.equal(t("permission denied", "", "macos"), "Location access is off");
assert.equal(explain("permission denied", "", "macos", false).act, "location");
assert.equal(t("permission denied"), "Scanning isn't permitted");
assert.equal(t("No Wi-Fi interface found"), "No Wi-Fi interface found");
assert.equal(t("something else"), "Scan failed");
