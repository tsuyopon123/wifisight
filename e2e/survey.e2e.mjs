// Survey E2E: drives the real UI in headless Chrome over CDP, with the Tauri backend replaced by a mock
// (window.__TAURI_INTERNALS__), and checks measuring / undo behaviour that unit checks can't see.
// Run: npm run e2e   (Chrome from $CHROME, else the usual install paths)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const BSSID = "aa:bb:cc:dd:ee:01";

const MOCK = `(() => {
  const m = (window.__mock = { rssi: { en0: -50, en1: -50 }, fail: false, failN: { en0: 0, en1: 0 }, delay: 300, autosave: null, scans: 0, errors: 0,
    link: { bssid: "${BSSID}", ssid: "event-net", rssiDbm: -70, txMbps: 866.7, rxMbps: null, mcs: 11, nss: 2 } });
  const bss = (rssi) => ({ bssid: "${BSSID}", ssid: "event-net", hidden: false, vendor: null, locallyAdministered: false, apName: "hall-1", model: null,
    band: "5", freqMhz: 5180, channel: 36, centerChannel: 36, centerFreqMhz: 5180, widthMhz: 20, freqLowMhz: 5170, freqHighMhz: 5190,
    rssiDbm: rssi, noiseDbm: null, snrDb: null, phyModes: ["a", "n", "ac"], generation: "Wi-Fi 5 (802.11ac)", maxRateMbps: 433.3, spatialStreams: 1,
    basicRates: [], supportedRates: [], security: { label: "WPA2-Personal", akms: ["PSK"], pairwise: ["CCMP"], group: "CCMP", groupMgmt: null, pmf: "disabled", wpa1: false, rsn: true },
    beaconIntervalTu: 100, capability: null, country: "JP", bssLoad: null, bssColor: null, txPowerDbm: null,
    features: { rrm11k: false, ft11r: false, bssTransition11v: false, wmm: true, wps: false, passpoint: false, interworking: false, oweTransition: false, mbo: false, multipleBssid: false, multiLink: false, twtRequired: false },
    roamingConsortium: [], vendorIes: [], ies: [], ageMs: null, connected: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    unregisterCallback() {},
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      switch (cmd) {
        case "platform_info": return { os: "macos", arch: "aarch64", version: "e2e", locationStatus: null, ouiEntries: 1, installable: false };
        case "list_interfaces": return [{ id: "en0", name: "en0", description: "", mac: null }, { id: "en1", name: "en1", description: "", mac: null }];
        case "scan": {
          const iface = (args && args.iface) || "en0";
          const rssi = m.rssi[iface]; // what the radio hears where the scan started
          m.busy = true;
          await sleep(m.delay);
          m.busy = false;
          if (m.failN[iface] > 0) { m.failN[iface]--; m.errors++; throw "mock scan failed"; }
          if (m.fail) { m.errors++; throw "mock scan failed"; }
          m.scans++;
          return { timestampMs: Date.now(), interface: iface, bss: [bss(rssi)], warnings: [] };
        }
        case "link_info": return m.link;
        case "autosave_read": return m.autosave;
        case "autosave_write": m.autosave = args.contents; return null;
        default:
          if (cmd.startsWith("plugin:dialog|")) return true;
          throw "unmocked command: " + cmd;
      }
    },
  };
})();`;

// ───────── app (vite) + headless Chrome ─────────
const freePort = () =>
  new Promise((ok) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const chromePath = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => p && existsSync(p));
if (!chromePath) throw new Error("Chrome not found: set CHROME to its path");

const server = await createServer({ server: { port: await freePort(), strictPort: true, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
const profile = mkdtempSync(join(tmpdir(), "wifisight-e2e-"));
let chrome;
let failed = 0;
try {
  chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--window-size=1440,900",
    "about:blank",
  ]);
  const port = await new Promise((ok, ng) => {
    let err = "";
    const timer = setTimeout(() => ng(new Error(`Chrome printed no DevTools address in 30 s: ${err}`)), 30000);
    chrome.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) clearTimeout(timer), ok(m[1]);
    });
    chrome.on("exit", (code) => ng(new Error(`Chrome exited (${code}): ${err}`)));
  });

  // ───────── CDP plumbing ─────────
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, ng) => ((ws.onopen = ok), (ws.onerror = ng)));
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.ng(new Error(JSON.stringify(msg.error))) : p.ok(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, ng) => {
      const id = ++seq;
      const timer = setTimeout(() => (pending.delete(id), ng(new Error(`CDP ${method}: no answer in 15 s`))), 15000);
      pending.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), ng: (e) => (clearTimeout(timer), ng(e)) });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(expr, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ev(expr)) return;
      await sleep(40);
    }
    throw new Error(`timeout waiting for: ${expr}`);
  }
  async function click({ x, y }) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }
  // viewport point of (fx, fy) on the 800×600 test plan at zoom "fit" (mirrors draw() / areaH() in survey.ts)
  const planPoint = (fx, fy) =>
    ev(`(() => {
      const cv = document.getElementById("sv-canvas"), r = cv.getBoundingClientRect();
      const cw = cv.parentElement.clientWidth, ch = cv.parentElement.clientHeight;
      const ah = Math.max(120, ch - 62), fit = Math.min(cw / 800, ah / 600), w = 800 * fit, h = 600 * fit;
      return { x: r.left + (cw - w) / 2 + ${fx} * w, y: r.top + (ah - h) / 2 + ${fy} * h };
    })()`);

  function check(name, got, want) {
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }

  // ───────── setup: app + survey with an 800×600 plan ─────────
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
  await send("Page.navigate", { url: base });
  await waitFor("window.__mock && window.__mock.scans > 0", 15000);
  await ev(`document.querySelector('#mode-seg button[data-mode="survey"]').click()`);
  await ev(`(async () => {
    const c = document.createElement("canvas");
    c.width = 800; c.height = 600;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 800, 600); g.strokeRect(10, 10, 780, 580);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "hall.png", { type: "image/png" }));
    const input = document.getElementById("sv-file-plan");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  })()`);
  await waitFor(`!document.getElementById("sv-zoom").hidden && !!window.__mock.autosave`);
  await sleep(200);

  const scaleText = () => ev(`document.getElementById("sv-scale-text").textContent`);
  async function setScale(metres) {
    await ev(`document.getElementById("sv-scale-set").click()`);
    await click(await planPoint(0.25, 0.5));
    await click(await planPoint(0.75, 0.5)); // 400 px apart on the plan
    await waitFor(`!document.getElementById("sv-scale-input").hidden`);
    await ev(`(() => { const i = document.getElementById("sv-scale-m"); i.value = "${metres}"; document.getElementById("sv-scale-ok").click(); })()`);
  }
  const undo = () => ev(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true }))`);

  {
    console.log("── A1: undo of Set scale");
    await setScale(10);
    check("scale after setting 10 m", await scaleText(), "20.0 × 15.0 m");
    await setScale(20);
    check("scale after setting 20 m", await scaleText(), "40.0 × 30.0 m");
    await undo();
    check("undo → previous scale", await scaleText(), "20.0 × 15.0 m");
    await undo();
    check("undo again → not set", await scaleText(), "not set");
  }

  {
    console.log("── A2: Instant mode must not record a scan from before the click");
    const nPoints = () => ev(`JSON.parse(window.__mock.autosave).points.filter((p) => p.scans > 0).length`);
    const lastRssi = () => ev(`(() => { const p = JSON.parse(window.__mock.autosave).points; return p[p.length - 1].rssi["${BSSID}"]; })()`);
    const freshScan = async () => {
      const n = await ev("window.__mock.scans");
      await waitFor(`window.__mock.scans > ${n}`);
      await sleep(50); // let main.ts ingest it
    };
    async function measureAt(fx, fy, label) {
      const before = await nPoints();
      const s0 = await ev("window.__mock.scans");
      await click(await planPoint(fx, fy));
      await waitFor(`JSON.parse(window.__mock.autosave).points.filter((p) => p.scans > 0).length > ${before}`, 10000);
      check(label, await lastRssi(), -80);
      return (await ev("window.__mock.scans")) - s0; // scans that finished between the click and the record
    }

    // 0) scanning normally: Instant still records the latest scan right away (no waiting for a 1.5 s scan)
    await ev(`window.__mock.rssi = { en0: -80, en1: -80 }; window.__mock.delay = 1500`);
    await freshScan();
    await freshScan(); // the first may have started before -80 was set
    // counted in scans, not ms: CDP input alone can take most of a second on a busy runner
    const waited = await measureAt(0.3, 0.6, "while scanning → latest scan");
    check("while scanning → recorded without waiting for another scan", waited, 0);
    await ev(`window.__mock.rssi = { en0: -50, en1: -50 }; window.__mock.delay = 300`);

    // 1) paused, then the user walks to a new spot (-80 there) and clicks: the scan from before the pause is stale
    await freshScan();
    await ev(`document.getElementById("btn-run").click()`); // pause
    await sleep(1000); // the scan in flight at pause time still lands
    await ev(`window.__mock.rssi = { en0: -80, en1: -80 }`);
    await measureAt(0.3, 0.3, "after pause → measures at the new spot");
    check("clicking resumed scanning", await ev(`document.getElementById("btn-run").textContent`), "Pause");

    // 1b) paused and resumed while a scan from before the pause was still running; it lands, then the user clicks
    await ev(`window.__mock.rssi = { en0: -50, en1: -50 }; window.__mock.delay = 1500`);
    await freshScan();
    await waitFor(`window.__mock.busy`);
    await ev(`document.getElementById("btn-run").click()`); // pause mid-scan (that scan hears -50)
    await ev(`window.__mock.rssi = { en0: -80, en1: -80 }`);
    await ev(`document.getElementById("btn-run").click()`); // resume before it finishes
    await freshScan(); // the pre-pause scan lands
    await measureAt(0.4, 0.6, "resumed mid-scan → the pre-pause scan isn't used");

    // 1c) 1 scan / point: click while a scan runs (it gets skipped), then pause + resume before it lands.
    //     Resume drops that scan, so the first scan after resume must be the one recorded.
    await ev(`(() => { const s = document.getElementById("sv-n"); s.value = "1"; s.dispatchEvent(new Event("change")); })()`);
    await freshScan();
    await waitFor(`window.__mock.busy`);
    const before1c = await nPoints();
    await click(await planPoint(0.5, 0.6));
    await ev(`document.getElementById("btn-run").click(); document.getElementById("btn-run").click()`); // pause, resume
    const atResume = await ev("window.__mock.scans");
    await waitFor(`JSON.parse(window.__mock.autosave).points.filter((p) => p.scans > 0).length > ${before1c}`, 10000);
    check("resume while waiting out a scan → scans finished until recorded (dropped + 1st new)", (await ev("window.__mock.scans")) - atResume, 2);
    await ev(`(() => { const s = document.getElementById("sv-n"); s.value = "0"; s.dispatchEvent(new Event("change")); })()`);
    await ev(`window.__mock.delay = 300`);

    // 2) switch to another interface: the last scan came from the old one
    await ev(`window.__mock.rssi = { en0: -50, en1: -80 }; window.__mock.delay = 800`);
    await freshScan();
    await ev(`(() => { const s = document.getElementById("sel-iface"); s.value = "en1"; s.dispatchEvent(new Event("change")); })()`);
    await measureAt(0.5, 0.3, "after switching interface → measures with the new one");

    // 3) scans failing: the last good scan is from before the failures
    await ev(`window.__mock.rssi = { en0: -50, en1: -50 }; window.__mock.delay = 300`);
    await freshScan();
    const errs = await ev("window.__mock.errors");
    await ev(`window.__mock.fail = true`);
    await waitFor(`window.__mock.errors > ${errs}`);
    await sleep(20);
    await ev(`window.__mock.fail = false; window.__mock.rssi = { en0: -80, en1: -80 }; window.__mock.delay = 800`);
    await measureAt(0.7, 0.3, "after a failed scan → waits for a good one");

    // ── second review
    const setN = (v) => ev(`(() => { const s = document.getElementById("sv-n"); s.value = "${v}"; s.dispatchEvent(new Event("change")); })()`);
    const setIface = (v) => ev(`(() => { const s = document.getElementById("sel-iface"); s.value = "${v}"; s.dispatchEvent(new Event("change")); })()`);
    const banner = () => ev(`document.getElementById("sv-status").hidden ? "" : document.getElementById("sv-status").textContent`);
    async function waitUntil(expr, ms) {
      try {
        await waitFor(expr, ms);
        return true;
      } catch {
        return false;
      }
    }
    const measuredExpr = (n) => `JSON.parse(window.__mock.autosave).points.filter((p) => p.scans > 0).length > ${n}`;

    // R1) pause + resume while a scan runs, then click before it lands: resume dropped that scan, so don't wait it out
    await setN("1");
    await ev(`window.__mock.rssi = { en0: -80, en1: -80 }; window.__mock.delay = 1500`);
    await freshScan();
    await waitFor(`window.__mock.busy`);
    await ev(`document.getElementById("btn-run").click(); document.getElementById("btn-run").click()`); // pause, resume
    let n0 = await nPoints();
    let s0 = await ev("window.__mock.scans");
    await click(await planPoint(0.6, 0.6));
    await waitFor(measuredExpr(n0), 10000);
    check("R1 resume, then click mid-scan → scans finished until recorded (dropped + 1st new)", (await ev("window.__mock.scans")) - s0, 2);

    // R2) 3 scans / point: 2 taken on en0, then switch to en1 → the point is measured on en1 only (no mixed radios)
    await setN("3");
    await ev(`window.__mock.rssi = { en0: -50, en1: -80 }; window.__mock.delay = 600`);
    await setIface("en0");
    await freshScan();
    n0 = await nPoints();
    await click(await planPoint(0.7, 0.6));
    await waitFor(`document.getElementById("sv-status").textContent.includes("Scan 3 of 3")`, 8000); // 2 samples in
    await setIface("en1");
    await waitFor(measuredExpr(n0), 15000);
    check("R2 interface switch mid-point → only the new radio's samples", await lastRssi(), -80);

    // R3) failures pile up on a dead source (2/3), then switch: the new source starts from 0, one transient failure is fine
    await setN("1");
    await ev(`window.__mock.rssi = { en0: -80, en1: -80 }; window.__mock.delay = 300; window.__mock.failN = { en0: 0, en1: 99 }`);
    n0 = await nPoints();
    await click(await planPoint(0.3, 0.8));
    await waitFor(`document.getElementById("sv-status").textContent.includes("(2/3)")`, 8000);
    await ev(`window.__mock.failN = { en0: 1, en1: 0 }`);
    await setIface("en0");
    const r3 = await waitUntil(measuredExpr(n0), 8000);
    check("R3 switch after failures → measured despite one failure on the new source", r3, true);
    if (!r3) await ev(`document.querySelector('#sv-status [data-st="discard"]')?.click()`);

    // R4) pause while a point is measured, then resume with the toolbar: the banner drops "paused" at once
    await ev(`window.__mock.failN = { en0: 0, en1: 0 }; window.__mock.delay = 1500`);
    await freshScan();
    n0 = await nPoints();
    await click(await planPoint(0.5, 0.8));
    await ev(`document.getElementById("btn-run").click()`); // pause
    const paused = await banner();
    await ev(`document.getElementById("btn-run").click()`); // resume
    const resumed = await banner();
    check("R4 banner while paused says so", paused.includes("Scanning is paused"), true);
    check("R4 banner right after resume no longer says paused", resumed.includes("Scanning is paused"), false);
    await waitFor(measuredExpr(n0), 10000);
    await setN("0");
    await ev(`window.__mock.delay = 300`);
  }

  // ───────── link poll: roaming log ─────────
  {
    check("L1 nothing logged while the AP stays (interface switches included)", await ev(`document.getElementById("st-roams").hidden`), true);
    await ev(`window.__mock.link = { ...window.__mock.link, bssid: "aa:bb:cc:dd:ee:02", rssiDbm: -48, txMbps: 1200 }`);
    await waitFor(`!document.getElementById("st-roams").hidden`, 5000);
    check("L2 status bar counts the roam", await ev(`document.getElementById("st-roams").textContent`), "1 roam");
    check("L3 status bar shows the rates", (await ev(`document.getElementById("st-scan").textContent`)).includes("tx 1200 Mbps · MCS 11×2"), true);
    await ev(`document.getElementById("st-roams").click()`);
    const row = await ev(`[...document.querySelectorAll("#roams-table tbody td")].slice(1).map((td) => td.textContent).join("|")`);
    check("L4 log row names the old AP from the scan", row, "roam|hall-1 (aa:bb:cc:dd:ee:01)|aa:bb:cc:dd:ee:02|-70 → -48|867 → 1200|");
    await ev(`document.getElementById("dlg-roams").close()`);
  }

  ws.close();
} catch (e) {
  failed++;
  console.error(e);
} finally {
  if (chrome && chrome.exitCode === null) {
    // the profile can only go once Chrome has stopped writing to it
    const gone = new Promise((ok) => (chrome.once("exit", ok), setTimeout(ok, 5000)));
    chrome.kill();
    await gone;
  }
  await server.close();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    // Chrome's helper processes on Linux can outlive it and keep writing; a leftover temp dir isn't a failure
    console.warn(`could not remove ${profile}: ${e.message}`);
  }
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
