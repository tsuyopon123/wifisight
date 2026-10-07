// Backend abstraction: Tauri commands when running in the app. In a plain
// browser (`npm run dev`) the UI loads but scanning reports an error.

import type { Interface, LinkInfo, PlatformInfo, ProbeInfo, Snapshot } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export async function platformInfo(): Promise<PlatformInfo> {
  if (isTauri) return invoke("platform_info");
  return { os: "browser", arch: "", version: "dev", locationStatus: null, ouiEntries: 0, installable: false };
}

const DESKTOP_ONLY = "Scanning is only available in the desktop app";

export async function probeInfo(probe: string): Promise<ProbeInfo | null> {
  if (isTauri) return invoke("probe_info", { probe });
  throw new Error(DESKTOP_ONLY);
}

export async function listInterfaces(probe: string | null): Promise<Interface[]> {
  if (isTauri) return invoke("list_interfaces", { probe });
  throw new Error(DESKTOP_ONLY);
}

export async function scan(iface: string | null, probe: string | null): Promise<Snapshot> {
  if (isTauri) return invoke("scan", { iface, probe });
  throw new Error(DESKTOP_ONLY);
}

export async function linkInfo(iface: string | null, probe: string | null): Promise<LinkInfo | null> {
  if (isTauri) return invoke("link_info", { iface, probe });
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
  URL.revokeObjectURL(a.href);
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
