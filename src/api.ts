/// <reference types="vite/client" />
// Backend abstraction: Tauri commands when running in the app; the probe's own HTTP API on the page a
// probe serves at /ui (`npm run build:probe`). In a plain browser (`npm run dev`) scanning reports an error.

import type { Interface, LinkInfo, PlatformInfo, ProbeInfo, Snapshot } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** Served by `wifisight-cli serve` at /ui: the probe is this page's origin. */
export const isProbePage = !isTauri && import.meta.env.MODE === "probe";
export const hasBackend = isTauri || isProbePage;

/** GET from the probe that serves this page; errors read like the desktop's probe_get, so main.ts explains them the same way. */
async function probeGet<T>(path: string): Promise<T> {
  const host = location.host;
  let res: Response;
  let body: string;
  try {
    // like the desktop's 15 s: a half-open connection would otherwise stall scans / link polls for good
    res = await fetch(path, { signal: AbortSignal.timeout(15000) });
    body = await res.text();
  } catch (e) {
    throw new Error(`probe ${host} unreachable: ${e}`);
  }
  if (!res.ok) throw new Error(`probe ${host}: HTTP ${res.status}: ${body}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`probe ${host}: bad response`);
  }
}

const ifaceQuery = (iface: string | null) => (iface ? `?iface=${encodeURIComponent(iface)}` : "");

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export async function platformInfo(): Promise<PlatformInfo> {
  if (isTauri) return invoke("platform_info");
  if (isProbePage) {
    const p = await probeGet<ProbeInfo>("/").catch(() => null);
    return { os: `probe ${p?.os ?? "?"}`, arch: "", version: p?.version ?? "?", locationStatus: null, ouiEntries: 0, installable: false };
  }
  return { os: "browser", arch: "", version: "dev", locationStatus: null, ouiEntries: 0, installable: false };
}

const DESKTOP_ONLY = "Scanning is only available in the desktop app";

export async function probeInfo(probe: string): Promise<ProbeInfo | null> {
  if (isTauri) return invoke("probe_info", { probe });
  if (isProbePage) return probeGet("/");
  throw new Error(DESKTOP_ONLY);
}

export async function listInterfaces(probe: string | null): Promise<Interface[]> {
  if (isTauri) return invoke("list_interfaces", { probe });
  if (isProbePage) return probeGet("/interfaces");
  throw new Error(DESKTOP_ONLY);
}

export async function scan(iface: string | null, probe: string | null): Promise<Snapshot> {
  if (isTauri) return invoke("scan", { iface, probe });
  if (isProbePage) {
    const s = await probeGet<Snapshot>("/bss" + ifaceQuery(iface));
    // like the desktop: stamp with this device's clock (a probe without RTC/NTP can be far off)
    return { ...s, timestampMs: Date.now(), interface: `probe:${s.interface}` };
  }
  throw new Error(DESKTOP_ONLY);
}

export async function linkInfo(iface: string | null, probe: string | null): Promise<LinkInfo | null> {
  if (isTauri) return invoke("link_info", { iface, probe });
  if (isProbePage) return probeGet("/link" + ifaceQuery(iface));
  return null;
}

export async function updateOui(): Promise<number> {
  if (isTauri) return invoke("update_oui_db");
  throw new Error("OUI download is only available in the desktop app");
}

/** Newer release (betas too when `beta`), or null when up to date. Throws when offline etc. */
export async function checkUpdate(beta: boolean) {
  if (!isTauri) throw new Error("Updates are only available in the desktop app");
  const { Update } = await import("@tauri-apps/plugin-updater");
  const meta = await invoke<ConstructorParameters<typeof Update>[0] | null>("check_update", { beta });
  return meta && new Update(meta);
}

export async function relaunch(): Promise<void> {
  if (isTauri) await (await import("@tauri-apps/plugin-process")).relaunch();
}

export async function openReleases(): Promise<void> {
  if (isTauri) await (await import("@tauri-apps/plugin-opener")).openUrl("https://github.com/tsuyopon123/wifisight/releases/latest");
}

export async function requestLocation(): Promise<void> {
  if (isTauri) await invoke("request_location");
}

export async function saveFile(defaultName: string, contents: string | Uint8Array, ext: string): Promise<string | null> {
  if (isTauri) {
    // the backend asks where to save and writes only there; null = cancelled
    if (typeof contents === "string") return invoke("save_text", { name: defaultName, ext, contents });
    // ponytail: bytes go over IPC as a JSON number array; fine for a few-MB PNG, use a raw-body command if it gets slow.
    return invoke("save_bytes", { name: defaultName, ext, contents: Array.from(contents) });
  }
  const type = { csv: "text/csv", png: "image/png" }[ext] ?? "application/json";
  const blob = new Blob([contents as BlobPart], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000); // iOS Safari drops the download if revoked at once
  return defaultName;
}

const AUTOSAVE_KEY = "wifisight.autosave";

export async function autosaveWrite(contents: string): Promise<void> {
  if (isTauri) return invoke("autosave_write", { contents });
  localStorage.setItem(AUTOSAVE_KEY, contents);
}

export async function autosaveRead(): Promise<string | null> {
  if (isTauri) return invoke("autosave_read");
  try {
    return localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    return null;
  }
}

export async function ask(message: string): Promise<boolean> {
  if (isTauri) return (await import("@tauri-apps/plugin-dialog")).ask(message, { kind: "warning" });
  return window.confirm(message);
}
