use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use wifi_core::{analyze, BssInfo, OuiDb};
use wifi_scan::{Interface, ScanOptions};

const OUI_URL: &str = "https://standards-oui.ieee.org/oui/oui.csv";

struct AppState {
    oui: Arc<Mutex<Option<OuiDb>>>,
    data_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    timestamp_ms: u64,
    interface: String,
    bss: Vec<BssInfo>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: &'static str,
    arch: &'static str,
    version: &'static str,
    location_status: Option<String>,
    oui_entries: usize,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn platform_info(state: State<'_, AppState>) -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        version: env!("CARGO_PKG_VERSION"),
        location_status: wifi_scan::location_permission_status(),
        oui_entries: state
            .oui
            .lock()
            .unwrap()
            .as_ref()
            .map(|d| d.len())
            .unwrap_or(0),
    }
}

/// GET JSON from an external probe (`wifisight-cli serve`). `probe` is "host:port" or a URL.
fn probe_get<T: serde::de::DeserializeOwned>(probe: &str, path: &str) -> Result<T, String> {
    let base = probe.trim().trim_end_matches('/');
    let url = if base.contains("://") {
        format!("{base}{path}")
    } else {
        format!("http://{base}{path}")
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut res = agent
        .get(&url)
        .call()
        .map_err(|e| format!("probe {base} unreachable: {e}"))?;
    let ok = res.status().is_success();
    let body = res
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("probe {base}: {e}"))?;
    if !ok {
        return Err(format!("probe {base}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("probe {base}: bad response: {e}"))
}

#[tauri::command]
async fn list_interfaces(probe: Option<String>) -> Result<Vec<Interface>, String> {
    tauri::async_runtime::spawn_blocking(move || match probe.filter(|p| !p.trim().is_empty()) {
        Some(p) => probe_get(&p, "/interfaces"),
        None => wifi_scan::interfaces().map_err(|e| e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan(
    state: State<'_, AppState>,
    iface: Option<String>,
    probe: Option<String>,
) -> Result<Snapshot, String> {
    let oui = state.oui.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let probe = probe.filter(|p| !p.trim().is_empty());
        let (interface, raws, warnings) = if let Some(p) = probe {
            let q = iface
                .map(|i| {
                    let enc: String = i
                        .bytes()
                        .map(|c| match c {
                            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                                (c as char).to_string()
                            }
                            _ => format!("%{c:02X}"),
                        })
                        .collect();
                    format!("?iface={enc}")
                })
                .unwrap_or_default();
            let o: wifi_scan::ScanOutput = probe_get(&p, &format!("/scan{q}"))?;
            (format!("probe:{}", o.interface), o.bss, o.warnings)
        } else {
            let o = wifi_scan::scan(&ScanOptions {
                interface: iface,
                trigger: true,
                wait: false,
            })
            .map_err(|e| e.to_string())?;
            (o.interface, o.bss, o.warnings)
        };
        let db = oui.lock().unwrap();
        let bss = raws.iter().map(|r| analyze(r, db.as_ref())).collect();
        Ok(Snapshot {
            timestamp_ms: now_ms(),
            interface,
            bss,
            warnings,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download the IEEE OUI registry into the app data dir and load it.
#[tauri::command]
async fn update_oui_db(state: State<'_, AppState>) -> Result<usize, String> {
    let path = state.data_dir.join("oui.csv");
    let oui = state.oui.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let text = ureq::get(OUI_URL)
            .header("User-Agent", "wifisight")
            .call()
            .map_err(|e| format!("download failed: {e}"))?
            .body_mut()
            .with_config()
            .limit(32 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| format!("download failed: {e}"))?;
        let db = OuiDb::from_ieee_csv(&text);
        if db.is_empty() {
            return Err("downloaded file did not contain OUI entries".into());
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&path, &text).map_err(|e| e.to_string())?;
        let n = db.len();
        *oui.lock().unwrap() = Some(db);
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// Survey autosave in the app data dir, so a long walk survives a crash / reload.
#[tauri::command]
fn autosave_write(state: State<'_, AppState>, contents: String) -> Result<(), String> {
    let _ = std::fs::create_dir_all(&state.data_dir);
    let path = state.data_dir.join("survey-autosave.json");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn autosave_read(state: State<'_, AppState>) -> Option<String> {
    std::fs::read_to_string(state.data_dir.join("survey-autosave.json")).ok()
}

#[tauri::command]
fn request_location(app: tauri::AppHandle) -> Result<(), String> {
    app.run_on_main_thread(wifi_scan::request_location_permission)
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("wifisight"));
            let oui = std::fs::read_to_string(data_dir.join("oui.csv"))
                .ok()
                .map(|t| OuiDb::from_ieee_csv(&t));
            app.manage(AppState {
                oui: Arc::new(Mutex::new(oui)),
                data_dir,
            });
            // macOS: SSID/BSSID are redacted without Location Services. setup() runs on the main thread.
            wifi_scan::request_location_permission();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform_info,
            list_interfaces,
            scan,
            update_oui_db,
            save_text,
            autosave_write,
            save_bytes,
            autosave_read,
            request_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running WiFiSight");
}
