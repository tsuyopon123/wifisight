// Website screenshots: drives the real UI with a mocked backend (like the E2E test) over a made-up venue,
// and writes site/img/*.png. Run: npm run screenshots   (Chrome from $CHROME, else the usual install paths)
import { mkdirSync, writeFileSync } from "node:fs";
import { launch, sleep } from "../e2e/harness.mjs";

const OUT = new URL("../site/img/", import.meta.url);
const PLAN = { w: 1600, h: 1000, metres: 60 }; // the floor plan is 60 m wide
const ROOMS = [0.42, 0.72]; // x of the walls between Hall A | Hall B | Foyer

// ───────── the venue: APs (position on the plan, 0..1) and the BSSes each one sends ─────────
const APS = [
  { name: "AP-HALL-A-01", id: "10", x: 0.14, y: 0.28, ch24: 1, ch5: [36, 40], ch6: [37, 160] },
  { name: "AP-HALL-A-02", id: "11", x: 0.3, y: 0.74, ch24: 6, ch5: [44, 40] },
  { name: "AP-HALL-B-01", id: "20", x: 0.52, y: 0.26, ch24: 11, ch5: [52, 40], ch6: [101, 160] },
  { name: "AP-HALL-B-02", id: "21", x: 0.62, y: 0.76, ch24: 1, ch5: [100, 80] },
  { name: "AP-FOYER-01", id: "30", x: 0.86, y: 0.5, ch24: 6, ch5: [116, 80] },
];
const SEC = {
  mixed: { label: "WPA2/WPA3-Personal", akms: ["PSK", "SAE"], pairwise: ["CCMP"], group: "CCMP", groupMgmt: "BIP-CMAC-128", pmf: "capable", wpa1: false, rsn: true },
  wpa3: { label: "WPA3-Personal", akms: ["SAE"], pairwise: ["CCMP"], group: "CCMP", groupMgmt: "BIP-CMAC-128", pmf: "required", wpa1: false, rsn: true },
  ent: { label: "WPA2/WPA3-Enterprise", akms: ["802.1X", "802.1X-SHA256"], pairwise: ["CCMP"], group: "CCMP", groupMgmt: "BIP-CMAC-128", pmf: "capable", wpa1: false, rsn: true },
  open: { label: "Open", akms: [], pairwise: [], group: null, groupMgmt: null, pmf: "disabled", wpa1: false, rsn: false },
};
const FEAT = { rrm11k: false, ft11r: false, bssTransition11v: false, wmm: true, wps: false, passpoint: false, interworking: false, oweTransition: false, mbo: false, multipleBssid: false, multiLink: false, twtRequired: false };

function radio(band, ch, width) {
  const base = band === "2.4" ? 2407 : band === "5" ? 5000 : 5950;
  // centre channel of a 40/80/160 MHz block in 5 / 6 GHz
  const span = width / 5;
  const first = band === "6" ? Math.floor((ch - 1) / span) * span + 1 : Math.floor((ch - 36) / span) * span + 36;
  const center = width === 20 || band === "2.4" ? ch : first + (span - 4) / 2;
  const cf = base + 5 * center;
  return { band, freqMhz: base + 5 * ch, channel: ch, centerChannel: center, centerFreqMhz: cf, widthMhz: width, freqLowMhz: cf - width / 2, freqHighMhz: cf + width / 2 };
}

function ies(b) {
  const f = (name, value) => ({ name, value });
  return [
    { id: 0, extId: null, name: "SSID", length: b.ssid.length, hex: "", fields: [f("SSID", b.ssid)] },
    { id: 7, extId: null, name: "Country", length: 6, hex: "", fields: [f("Country", "JP")] },
    { id: 11, extId: null, name: "BSS Load", length: 5, hex: "", fields: [f("Stations", String(b.bssLoad?.stationCount ?? 0))] },
    { id: 48, extId: null, name: "RSN", length: 26, hex: "", fields: [f("AKM", b.security.akms.join(", ") || "—")] },
    { id: 70, extId: null, name: "RM Enabled Capabilities", length: 5, hex: "", fields: [] },
    { id: 127, extId: null, name: "Extended Capabilities", length: 11, hex: "", fields: [f("BSS Transition", "yes")] },
    { id: 255, extId: 35, name: "HE Capabilities", length: 33, hex: "", fields: [] },
    { id: 255, extId: 36, name: "HE Operation", length: 10, hex: "", fields: [f("BSS Color", String(b.bssColor))] },
    { id: 221, extId: null, name: "Vendor Specific (Cisco)", length: 30, hex: "", fields: [f("AP name", b.apName ?? "")] },
  ];
}

const BSS = [];
let seed = 7;
const rnd = (n) => ((seed = (seed * 9301 + 49297) % 233280), Math.floor((seed / 233280) * n));
for (const ap of APS) {
  const add = (ssid, sec, r, sub, extra = {}) => {
    const b = {
      bssid: `00:3a:99:${ap.id}:${sub}`, ssid, hidden: false, vendor: "Cisco Systems, Inc", locallyAdministered: false, apName: ap.name, model: null,
      ...r, rssiDbm: -60, noiseDbm: r.band === "2.4" ? -90 : -95, snrDb: null,
      phyModes: r.band === "2.4" ? ["b", "g", "n", "ax"] : r.band === "5" ? ["a", "n", "ac", "ax"] : ["ax"],
      generation: r.band === "6" ? "Wi-Fi 6E (802.11ax)" : "Wi-Fi 6 (802.11ax)",
      maxRateMbps: { 20: 287, 40: 574, 80: 1201, 160: 2402 }[r.widthMhz], spatialStreams: 2,
      basicRates: r.band === "2.4" ? [1, 2, 5.5, 11] : [6, 12, 24], supportedRates: r.band === "2.4" ? [1, 2, 5.5, 11, 6, 9, 12, 18, 24, 36, 48, 54] : [6, 9, 12, 18, 24, 36, 48, 54],
      security: sec, beaconIntervalTu: 100, capability: null, country: "JP",
      bssLoad: { stationCount: 3 + rnd(30), channelUtilizationPct: r.band === "2.4" ? 30 + rnd(40) : 5 + rnd(30), availableAdmissionCapacity: 0 },
      bssColor: 1 + rnd(60), txPowerDbm: r.band === "2.4" ? 14 : 17,
      features: { ...FEAT, rrm11k: true, bssTransition11v: true, ft11r: sec !== SEC.open, ...extra },
      roamingConsortium: [], vendorIes: [], ageMs: null, connected: false, pos: { x: ap.x, y: ap.y },
    };
    b.ies = ies(b);
    BSS.push(b);
  };
  add("TechConf", SEC.mixed, radio("2.4", ap.ch24, 20), "00:00");
  add("TechConf", SEC.mixed, radio("5", ...ap.ch5), "00:0f");
  add("OpenRoaming", SEC.ent, radio("5", ...ap.ch5), "00:0e", { passpoint: true, interworking: true });
  if (ap.ch6) add("TechConf-6G", SEC.wpa3, radio("6", ...ap.ch6), "60:01");
}
// neighbours that aren't ours: the hotel's network and someone's phone
for (const [sub, ch, x, y] of [["03", 1, 0.95, 0.1], ["13", 11, 0.98, 0.9]]) {
  BSS.push({
    ...BSS[0], bssid: `1c:b1:7f:30:00:${sub}`, ssid: "HOTEL_GUEST", vendor: "NEC Platforms, Ltd.", apName: null, ...radio("2.4", ch, 20),
    phyModes: ["b", "g", "n"], generation: "Wi-Fi 4 (802.11n)", maxRateMbps: 144, security: SEC.open, bssLoad: null, bssColor: null,
    features: FEAT, pos: { x, y }, ies: [],
  });
}
BSS.push({
  ...BSS[1], bssid: "2a:11:5c:8e:41:07", ssid: "MyPhone-Hotspot", vendor: null, locallyAdministered: true, apName: null, ...radio("5", 149, 80),
  security: SEC.wpa3, bssLoad: null, features: FEAT, pos: { x: 0.36, y: 0.5 }, ies: [],
});

// ───────── mocked backend (runs in the page) ─────────
function mock({ bss, rooms, planM }) {
  const m = (window.__mock = { pos: { x: 0.18, y: 0.34 }, gain: 0, scans: 0, delay: 150, autosave: null, link: null });
  const room = (x) => rooms.filter((w) => x > w).length;
  const at1m = { "2.4": -34, 5: -38, 6: -42 };
  function rssiAt(b, p, n) {
    const d = Math.max(1, Math.hypot((p.x - b.pos.x) * planM.w, (p.y - b.pos.y) * planM.h));
    const walls = Math.abs(room(p.x) - room(b.pos.x));
    const jitter = Math.sin(n * 0.25 + b.freqMhz) * 1.5 + Math.sin(n * 0.9 + p.x * 31 + p.y * 17) * 0.8;
    const ssidOffset = b.ssid === "OpenRoaming" ? -3 : 0; // keeps its spectrum label clear of TechConf on the same radio
    return Math.round(at1m[b.band] - 32 * Math.log10(d) - 9 * walls + jitter + ssidOffset + m.gain);
  }
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    unregisterCallback() {},
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      switch (cmd) {
        case "platform_info": return { os: "macos", arch: "aarch64", version: "1.0.0", locationStatus: "authorized", ouiEntries: 1, installable: false };
        case "list_interfaces": return [{ id: "en0", name: "en0", description: "", mac: null }];
        case "scan": {
          await new Promise((r) => setTimeout(r, m.delay));
          const n = ++m.scans;
          const list = bss
            .map(({ pos, ...b }) => {
              const rssiDbm = rssiAt({ ...b, pos }, m.pos, n);
              return { ...b, rssiDbm, snrDb: rssiDbm - b.noiseDbm, connected: b.bssid === m.link?.bssid };
            })
            .filter((b) => b.rssiDbm > -90);
          return { timestampMs: Date.now(), interface: "en0", bss: list, warnings: [] };
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
}

// ───────── shoot ─────────
mkdirSync(OUT, { recursive: true });
const h = await launch();
const { base, send, ev, waitFor, click } = h;
let failed = false;
try {
  // the whole window, or just the element `sel` (+ `pad` px around it)
  const shot = async (name, sel, pad = 0) => {
    await sleep(400); // let charts settle
    const clip = sel && (await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: r.left - ${pad}, y: r.top - ${pad}, width: r.width + ${2 * pad}, height: r.height + ${2 * pad}, scale: 1 }; })()`));
    const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip && { clip }) });
    writeFileSync(new URL(name, OUT), Buffer.from(data, "base64"));
    console.log(`wrote site/img/${name}`);
  };
  const freshScan = async () => {
    const n = await ev("window.__mock.scans");
    await waitFor(`window.__mock.scans > ${n}`);
    await sleep(60);
  };
  const data = { bss: BSS, rooms: ROOMS, planM: { w: PLAN.metres, h: (PLAN.metres * PLAN.h) / PLAN.w } };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${mock})(${JSON.stringify(data)})` });
  await send("Page.navigate", { url: base });
  await waitFor("window.__mock && window.__mock.scans > 0", 15000);
  const pick = (id, v) => ev(`(() => { const s = document.getElementById("${id}"); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change")); })()`);
  await pick("sel-interval", "0");
  await pick("sel-history", "60000");

  // connected to Hall A's 5 GHz TechConf; a minute of signal history while strolling around the hall
  await ev(`window.__mock.link = { bssid: "00:3a:99:10:00:0f", ssid: "TechConf", rssiDbm: -42, txMbps: 1080.6, rxMbps: null, mcs: 11, nss: 2 }`);
  await ev(`window.__mock.delay = 300; window.__mock.gain = 12`); // the scanner shots: more of the venue in the list
  for (let t0 = Date.now(), i = 0; Date.now() - t0 < 62000; i++) {
    await ev(`window.__mock.pos = { x: ${0.18 + 0.05 * Math.sin(i / 30)}, y: ${0.34 + 0.08 * Math.sin(i / 47)} }`);
    await freshScan();
  }
  await ev(`window.__mock.delay = 150`);
  await ev(`document.querySelector('#bss-table tr[data-bssid="00:3a:99:10:00:0f"]').click()`);
  await ev(`document.querySelector('#tabs [data-tab="5"]').click()`);
  await shot("scanner.png");
  // link preview (og:image): the top of the scanner at 1.91:1, 2400×1256
  {
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1440, height: 754, scale: 0.8333 } });
    writeFileSync(new URL("og.png", OUT), Buffer.from(data, "base64"));
    console.log("wrote site/img/og.png");
  }
  await ev(`document.querySelector('#tabs [data-tab="load"]').click()`);
  await shot("channels.png", "#bottom");
  await ev(`document.querySelector('#tabs [data-tab="signal"]').click()`);
  await shot("signal.png", "#bottom");

  // roaming: walk from Hall A to Hall B and the foyer
  const roams = [
    ["00:3a:99:11:00:0f", -71, -47, 1080.6, 1201, { x: 0.28, y: 0.7 }],
    ["00:3a:99:21:00:0f", -73, -51, 864.7, 1201, { x: 0.6, y: 0.72 }],
    ["00:3a:99:30:00:0f", -70, -44, 720.6, 1201, { x: 0.84, y: 0.52 }],
  ];
  for (const [bssid, before, after, txBefore, txAfter, pos] of roams) {
    await ev(`window.__mock.pos = ${JSON.stringify(pos)}`); // walk there, so the scan names the new AP
    await ev(`window.__mock.link = { ...window.__mock.link, rssiDbm: ${before}, txMbps: ${txBefore} }`);
    await sleep(1300);
    await ev(`window.__mock.link = { ...window.__mock.link, bssid: "${bssid}", rssiDbm: ${after}, txMbps: ${txAfter} }`);
    await sleep(1300);
  }
  await waitFor(`document.getElementById("st-roams").textContent === "3 roams"`, 5000);
  await ev(`document.getElementById("st-roams").click()`);
  await shot("roaming.png", "#dlg-roams");
  await ev(`document.getElementById("dlg-roams").close()`);

  await ev(`window.__mock.gain = 0`);

  // survey: draw a floor plan, set the scale, measure on a grid
  await ev(`document.querySelector('#mode-seg button[data-mode="survey"]').click()`);
  await ev(`(async () => {
    const W = ${PLAN.w}, H = ${PLAN.h}, walls = ${JSON.stringify(ROOMS)};
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "#222"; g.lineWidth = 6; g.strokeRect(20, 20, W - 40, H - 40);
    g.lineWidth = 4;
    for (const w of walls) { // inner walls with two doors each
      const x = w * W;
      g.beginPath(); g.moveTo(x, 20); g.lineTo(x, H * 0.3); g.moveTo(x, H * 0.4); g.lineTo(x, H * 0.6); g.moveTo(x, H * 0.7); g.lineTo(x, H - 20); g.stroke();
    }
    g.lineWidth = 2; g.strokeStyle = "#555";
    g.strokeRect(W * 0.04, H * 0.06, W * 0.12, H * 0.88); // stage, Hall A
    g.strokeRect(W * 0.44, H * 0.06, W * 0.1, H * 0.2); // stage, Hall B
    g.strokeRect(W * 0.8, H * 0.38, W * 0.14, H * 0.24); // registration desk
    for (let r = 0; r < 8; r++) for (let s = 0; s < 3; s++) g.strokeRect(W * (0.2 + s * 0.065), H * (0.1 + r * 0.105), W * 0.055, H * 0.05); // tables
    g.fillStyle = "#333"; g.font = "bold 40px sans-serif"; g.textAlign = "center";
    g.fillText("HALL A", W * 0.29, H * 0.96 - 20); g.fillText("HALL B", W * 0.57, H * 0.96 - 20); g.fillText("FOYER", W * 0.86, H * 0.96 - 20);
    g.font = "28px sans-serif"; g.fillText("Registration", W * 0.87, H * 0.51);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "convention-center.png", { type: "image/png" }));
    const input = document.getElementById("sv-file-plan");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  })()`);
  await waitFor(`!document.getElementById("sv-zoom").hidden && !!window.__mock.autosave`);
  await sleep(300);
  // viewport point of (fx, fy) on the plan at zoom "fit" (mirrors draw() / areaH() in survey.ts)
  const planPoint = (fx, fy) =>
    ev(`(() => {
      const cv = document.getElementById("sv-canvas"), r = cv.getBoundingClientRect();
      const cw = cv.parentElement.clientWidth, ch = cv.parentElement.clientHeight;
      const ah = Math.max(120, ch - 62), fit = Math.min(cw / ${PLAN.w}, ah / ${PLAN.h}), w = ${PLAN.w} * fit, h = ${PLAN.h} * fit;
      return { x: r.left + (cw - w) / 2 + ${fx} * w, y: r.top + (ah - h) / 2 + ${fy} * h };
    })()`);
  await ev(`document.getElementById("sv-scale-set").click()`);
  await click(await planPoint(0.1, 0.5));
  await click(await planPoint(0.9, 0.5));
  await waitFor(`!document.getElementById("sv-scale-input").hidden`);
  await ev(`(() => { document.getElementById("sv-scale-m").value = "${PLAN.metres * 0.8}"; document.getElementById("sv-scale-ok").click(); })()`);

  const measured = () => ev(`JSON.parse(window.__mock.autosave).points.filter((p) => p.scans > 0).length`);
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 8; c++) {
      const fx = 0.06 + c * 0.125 + (r % 2) * 0.03, fy = 0.1 + r * 0.2;
      await ev(`window.__mock.pos = { x: ${fx}, y: ${fy} }`);
      await freshScan();
      await freshScan(); // the first may have started before the move
      const n = await measured();
      await click(await planPoint(fx, fy));
      await waitFor(`JSON.parse(window.__mock.autosave).points.filter((p) => p.scans > 0).length > ${n}`, 10000);
    }
  }
  await ev(`(() => { const s = document.getElementById("sv-layer"); s.value = "ssid:TechConf"; s.dispatchEvent(new Event("change")); })()`);
  await ev(`document.getElementById("btn-run").click()`); // pause, so the status bar doesn't tick in the shot
  await waitFor(`document.getElementById("sv-toast").hidden`, 10000);
  await shot("survey.png");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await h.close();
}
process.exit(failed ? 1 : 0);
