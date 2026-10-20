// Backend error strings → what happened and what to do about it.

export type Act = "settings" | "location" | undefined;

export interface Explained {
  title: string;
  hint: string;
  act?: Act;
}

/** Action buttons for an explained error; `attr` names the data attribute the click handler reads. */
export const actions = (act: Act, attr: string) =>
  act === "location"
    ? `<div class="acts"><button ${attr}="location" class="primary">Request location access</button><button ${attr}="settings">Settings…</button></div>`
    : act === "settings"
      ? `<div class="acts"><button ${attr}="settings" class="primary">Check probe / interface…</button></div>`
      : "";

/** `probe`: the probe in use ("" = local Wi-Fi); `os`: platform of this app; `probePage`: running as the probe's /ui page. */
export function explain(err: string, probe: string, os: string, probePage: boolean): Explained {
  const e = err.toLowerCase();
  if (e.includes("desktop app"))
    return { title: "Scanning needs the desktop app", hint: "This browser preview can't reach Wi-Fi. Run the app (npm run tauri dev) to scan." };
  if (e.includes("probe")) {
    // probe_get: "unreachable" = no connection; "HTTP 500: …" = the probe answered but its scan failed
    if (/bad response|: http 404:/.test(e))
      return { title: `${probe} isn't a WiFiSight probe`, hint: "Check the address and port, and that it runs a current wifisight-cli serve.", act: "settings" };
    if (/: http \d{3}:/.test(e))
      return {
        title: `Probe ${probe} can't scan`,
        hint: e.includes("permission")
          ? "The probe needs CAP_NET_ADMIN to scan (the wifisight-probe service grants it) — check the service on the probe."
          : "Check that Wi-Fi is on at the probe, or pick another interface in Settings.",
        act: "settings",
      };
    return {
      title: `Can't reach probe ${probe}`,
      hint: probePage
        ? "Check that this device can still reach it on the network and that wifisight-cli serve is running there."
        : "Check that this computer can reach it on the network and that wifisight-cli serve is running there — or clear Probe in Settings to use this computer's Wi-Fi.",
      act: "settings",
    };
  }
  if (e.includes("permission")) {
    if (os === "macos")
      return { title: "Location access is off", hint: "macOS only lets apps scan Wi-Fi with Location Services on: System Settings › Privacy & Security › Location Services.", act: "location" };
    if (os === "windows")
      return { title: "Location access is off", hint: "Windows needs Settings › Privacy & security › Location › “Let desktop apps access your location” to scan Wi-Fi.", act: "settings" };
    return { title: "Scanning isn't permitted", hint: "Active scans need CAP_NET_ADMIN: sudo setcap cap_net_admin+ep <path to wifisight>, or run NetworkManager.", act: "settings" };
  }
  if (e.includes("no wi-fi interface"))
    return { title: "No Wi-Fi interface found", hint: "Turn Wi-Fi on, or pick another interface or a probe in Settings.", act: "settings" };
  return { title: "Scan failed", hint: "Retrying every interval. Check that Wi-Fi is on, or pick another interface / probe in Settings.", act: "settings" };
}
