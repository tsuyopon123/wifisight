import type { Track } from "./types";
import { esc, fmtAgo, fmtRate, isDfs, vendorHtml } from "./util";

const RCOI: [string, string][] = [
  ["5A03BA", "OpenRoaming (settlement-free)"],
  ["BAA2D0", "OpenRoaming (settled)"],
  ["001BC50460", "eduroam"],
];

function kv(rows: [string, string | number | null | undefined][]): string {
  return (
    `<dl class="kv">` +
    rows
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${typeof v === "number" ? v : v}</dd>`)
      .join("") +
    `</dl>`
  );
}

function chip(label: string, on: boolean, title = ""): string {
  return `<span class="chip${on ? " on" : ""}" title="${esc(title)}">${label}</span>`;
}

const ACTIONS = `<div class="d-actions"><button data-act="copy">Copy text</button><button data-act="json">Export JSON…</button><button data-act="close" title="Close (Esc)" aria-label="Close details">×</button></div>`;

export function renderDetails(el: HTMLElement, t: Track) {
  // Don't wipe a text selection the user is making/copying; resumes once it's cleared.
  const sel = getSelection();
  if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
  const b = t.info;
  const s = b.security;
  const f = b.features;
  const now = Date.now();
  const rcoi = b.roamingConsortium
    .map((oi) => {
      const l = RCOI.find(([p]) => oi.toUpperCase().startsWith(p));
      return `${oi}${l ? ` <span style="color:var(--fg-2)">— ${l[1]}</span>` : ""}`;
    })
    .join("<br>");

  el.innerHTML = ACTIONS + `
    <h2>${b.hidden ? '<span class="hidden-ssid">(hidden SSID)</span>' : esc(b.ssid)}${b.connected ? ` <span class="conn">● connected${t.mlo ? " via MLO" : ""}</span>` : ""}</h2>
    <div class="sub">${b.bssid}${b.vendor ? " · " + vendorHtml(b.vendor, false) : ""}${b.locallyAdministered ? " · locally administered" : ""}${b.apName ? " · " + esc(b.apName) : ""}${b.model ? " · " + esc(b.model) : ""}</div>

    <h3>Radio</h3>
    ${kv([
      ["Band / Channel", `${b.band} GHz · ch ${b.channel}${isDfs(b) ? " (DFS)" : ""}`],
      ["Width", `${b.widthMhz} MHz · center ch ${b.centerChannel} (${b.centerFreqMhz} MHz)`],
      ["Occupies", `${b.freqLowMhz}–${b.freqHighMhz} MHz`],
      ["Signal", `${b.rssiDbm} dBm  (min ${t.minRssi} / max ${t.maxRssi})`],
      ["Noise / SNR", b.noiseDbm != null ? `${b.noiseDbm} dBm / ${b.snrDb} dB` : null],
      ["TX power (TPC)", b.txPowerDbm != null ? `${b.txPowerDbm} dBm` : null],
      ["MLO", b.mld ? `AP MLD ${b.mld}${b.mldLinkId != null ? ` · link ${b.mldLinkId}` : ""}` : null],
      ["BSS Color", b.bssColor],
      ["Country", b.country],
      ["Beacon interval", b.beaconIntervalTu != null ? `${b.beaconIntervalTu} TU` : null],
      ["First / last seen", `${fmtAgo(now - t.firstSeen)} ago / ${fmtAgo(now - t.lastSeen)} ago`],
    ])}

    <h3>Capabilities</h3>
    ${kv([
      ["Generation", b.generation],
      ["PHY", b.phyModes.join(" / ")],
      ["Spatial streams", b.spatialStreams],
      ["Max PHY rate", b.maxRateMbps != null ? `${fmtRate(b.maxRateMbps)} Mbps` : null],
      ["Basic rates", b.basicRates.join(", ")],
      ["Supported rates", b.supportedRates.join(", ")],
    ])}
    <div class="chips" style="margin-top:8px">
      ${chip("11k", f.rrm11k, "Radio Measurement (RM Enabled Capabilities)")}
      ${chip("11v", f.bssTransition11v, "BSS Transition Management")}
      ${chip("11r", f.ft11r, "Fast BSS Transition")}
      ${chip("WMM", f.wmm)}
      ${chip("WPS", f.wps)}
      ${chip("Passpoint", f.passpoint, "Hotspot 2.0")}
      ${chip("Interworking", f.interworking)}
      ${chip("OWE TM", f.oweTransition, "OWE Transition Mode")}
      ${chip("MBO", f.mbo)}
      ${chip("MBSSID", f.multipleBssid, "Multiple BSSID")}
      ${chip("MLO", f.multiLink, "Multi-Link (802.11be)")}
      ${chip("TWT req", f.twtRequired)}
    </div>

    <h3>Security</h3>
    ${kv([
      ["Mode", s.label],
      ["AKM", s.akms.join(", ")],
      ["Pairwise", s.pairwise.join(", ")],
      ["Group", s.group],
      ["Group mgmt", s.groupMgmt],
      ["PMF (802.11w)", s.pmf],
      ["Roaming Consortium", rcoi],
    ])}

    ${
      b.bssLoad
        ? `<h3>BSS Load</h3>${kv([
            ["Clients", b.bssLoad.stationCount],
            ["Channel utilization", `${b.bssLoad.channelUtilizationPct.toFixed(1)} %`],
            ["Admission capacity", b.bssLoad.availableAdmissionCapacity],
          ])}`
        : ""
    }

    <h3>Information Elements (${b.ies.length})</h3>
    ${b.ies
      .map(
        (ie) => `<details class="ie" open><summary><span class="id">${ie.id}${ie.extId != null ? "/" + ie.extId : ""}</span><span>${esc(
          ie.name,
        )}</span><span class="len">${ie.length} B</span></summary><div class="body">${
          ie.fields.length ? kv(ie.fields.map((x) => [x.name, esc(x.value)])) : ""
        }<pre>${ie.hex.replace(/(..)/g, "$1 ").trim()}</pre></div></details>`,
      )
      .join("")}
    ${b.ies.length === 0 ? `<div style="color:var(--fg-3)">No IE data from the OS for this BSS.</div>` : ""}
  `;
}

/** Pane contents as plain text (minus the action buttons). */
export function detailsText(el: HTMLElement): string {
  return [...el.children]
    .filter((c) => !c.classList.contains("d-actions"))
    .map((c) => (c as HTMLElement).innerText)
    .join("\n");
}
