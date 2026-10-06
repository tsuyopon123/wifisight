use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use wifi_core::{analyze, BssInfo, OuiDb};
use wifi_scan::Interface;

const OUI_URL: &str = "https://standards-oui.ieee.org/oui/oui.csv";
/// Published releases, newest first, pre-releases included (drafts are hidden without auth).
#[cfg(desktop)]
const RELEASES_API: &str = "https://api.github.com/repos/tsuyopon123/wifisight/releases?per_page=20";

/// Managed on the builder, not in setup(): on Android the page can call commands before setup() runs.
#[derive(Default)]
struct AppState {
    oui: Arc<Mutex<Option<OuiDb>>>,
}

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("wifisight"))
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
    version: String,
    location_status: Option<String>,
    oui_entries: usize,
    /// false for the Windows portable exe: the updater would run the NSIS installer instead.
    installable: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// async: on Android the location status comes from the Kotlin plugin, which runs on the UI thread
#[tauri::command]
async fn platform_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PlatformInfo, String> {
    #[cfg(target_os = "android")]
    let location_status = Some(android::permission_status(&app).await?);
    #[cfg(not(target_os = "android"))]
    let location_status = wifi_scan::location_permission_status();
    Ok(PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        // tauri.conf version: CI sets it from the tag (e.g. 0.1.0-beta.3); Cargo stays 0.1.0
        version: app.package_info().version.to_string(),
        location_status,
        oui_entries: state
            .oui
            .lock()
            .unwrap()
            .as_ref()
            .map(|d| d.len())
            .unwrap_or(0),
        installable: cfg!(desktop)
            && (!cfg!(windows)
                || std::env::current_exe()
                    .is_ok_and(|p| p.with_file_name("uninstall.exe").exists())),
    })
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
    let status = res.status();
    let body = res
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("probe {base}: {e}"))?;
    if !status.is_success() {
        return Err(format!("probe {base}: HTTP {}: {body}", status.as_u16()));
    }
    serde_json::from_str(&body).map_err(|e| format!("probe {base}: bad response: {e}"))
}

/// Probe health check (`GET /`): app name, version, OS.
#[tauri::command]
async fn probe_info(probe: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || probe_get(&probe, "/"))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_interfaces(probe: Option<String>) -> Result<Vec<Interface>, String> {
    tauri::async_runtime::spawn_blocking(move || match probe.filter(|p| !p.trim().is_empty()) {
        Some(p) => probe_get(&p, "/interfaces"),
        #[cfg(target_os = "android")]
        None => Ok(vec![android::interface()]),
        #[cfg(not(target_os = "android"))]
        None => wifi_scan::interfaces().map_err(|e| e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan(
    #[allow(unused_variables)] app: tauri::AppHandle,
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
            // blocking pool, not the UI thread, so waiting on the Kotlin plugin is fine
            #[cfg(target_os = "android")]
            let o = android::scan(&app)?;
            #[cfg(not(target_os = "android"))]
            let o = wifi_scan::scan(&wifi_scan::ScanOptions {
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
async fn update_oui_db(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let path = data_dir(&app).join("oui.csv");
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

#[cfg(desktop)]
/// latest.json of the newest published release, betas included. The stable channel instead
/// uses the configured releases/latest endpoint, which skips pre-releases.
fn beta_manifest_url() -> Result<tauri::Url, String> {
    #[derive(serde::Deserialize)]
    struct Asset {
        name: String,
        browser_download_url: String,
    }
    #[derive(serde::Deserialize)]
    struct Release {
        assets: Vec<Asset>,
    }
    // ponytail: env override only exists to point a test build at a local server
    let api = std::env::var("WIFISIGHT_RELEASES_API").unwrap_or_else(|_| RELEASES_API.into());
    let body = ureq::get(&api)
        .header("User-Agent", "wifisight")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("release list: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("release list: {e}"))?;
    let releases: Vec<Release> = serde_json::from_str(&body).map_err(|e| format!("release list: {e}"))?;
    let url = releases
        .into_iter()
        .flat_map(|r| r.assets)
        .find(|a| a.name == "latest.json")
        .ok_or("no published release has latest.json")?
        .browser_download_url;
    url.parse().map_err(|e| format!("{url}: {e}"))
}

#[cfg(desktop)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

/// The updater plugin's `check` with a beta channel added (its JS `check()` can't change the
/// endpoint). Returns what the JS `Update` class takes, so download/install stay the plugin's.
#[cfg(desktop)]
#[tauri::command]
async fn check_update(webview: tauri::Webview, beta: bool) -> Result<Option<UpdateMetadata>, String> {
    let mut builder = webview.updater_builder();
    if beta {
        let url = tauri::async_runtime::spawn_blocking(beta_manifest_url)
            .await
            .map_err(|e| e.to_string())??;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    Ok(Some(UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: None, // only shown by the plugin's own UI helpers, which we don't use
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

/// Ask where to save with the native dialog, then write there. The webview never names the path,
/// so it can only write where the user picked. `None` = cancelled.
fn save_with_dialog(
    window: &tauri::Window,
    name: &str,
    ext: &str,
    contents: &[u8],
) -> Result<Option<String>, String> {
    let dialog = window.dialog().file();
    #[cfg(desktop)]
    let dialog = dialog.set_parent(window);
    let Some(path) = dialog
        .set_file_name(name)
        .add_filter(ext.to_uppercase(), &[ext])
        .blocking_save_file() // async command: off the main thread, like the plugin's own save
    else {
        return Ok(None);
    };
    // Android hands back a content:// URI, which only the fs plugin can open
    #[cfg(target_os = "android")]
    {
        use std::io::Write;
        use tauri_plugin_fs::{FsExt, OpenOptions};
        let mut opts = OpenOptions::new();
        opts.write(true).truncate(true).create(true); // "wt": plain "w" may leave a longer old file's tail
        let shown = path.to_string();
        window
            .fs()
            .open(path, opts)
            .and_then(|mut f| f.write_all(contents))
            .map_err(|e| e.to_string())?;
        Ok(Some(shown))
    }
    #[cfg(not(target_os = "android"))]
    {
        let path = path.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, contents).map_err(|e| e.to_string())?;
        Ok(Some(path.display().to_string()))
    }
}

#[tauri::command]
async fn save_text(
    window: tauri::Window,
    name: String,
    ext: String,
    contents: String,
) -> Result<Option<String>, String> {
    save_with_dialog(&window, &name, &ext, contents.as_bytes())
}

#[tauri::command]
async fn save_bytes(
    window: tauri::Window,
    name: String,
    ext: String,
    contents: Vec<u8>,
) -> Result<Option<String>, String> {
    save_with_dialog(&window, &name, &ext, &contents)
}

/// Survey autosave in the app data dir, so a long walk survives a crash / reload.
#[tauri::command]
fn autosave_write(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let dir = data_dir(&app);
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("survey-autosave.json");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn autosave_read(app: tauri::AppHandle) -> Option<String> {
    std::fs::read_to_string(data_dir(&app).join("survey-autosave.json")).ok()
}

#[tauri::command]
async fn request_location(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return android::request_access(&app).await;
    #[cfg(not(target_os = "android"))]
    app.run_on_main_thread(wifi_scan::request_location_permission)
        .map_err(|e| e.to_string())
}

/// Wi-Fi scanning through the Kotlin plugin in gen/android (WifiScanPlugin.kt), which returns
/// `RawBss` like the desktop backends in wifi-scan.
#[cfg(target_os = "android")]
mod android {
    use serde::Deserialize;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Wry};
    use wifi_scan::{Interface, ScanOutput};

    struct Scanner(PluginHandle<Wry>);

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("wifiscan")
            .setup(|app, api| {
                let h = api.register_android_plugin("dev.tsuyopon.wifisight", "WifiScanPlugin")?;
                app.manage(Scanner(h));
                Ok(())
            })
            .build()
    }

    /// Android exposes no interface choice to apps.
    pub fn interface() -> Interface {
        Interface {
            id: "wlan0".into(),
            name: "wlan0".into(),
            description: "Wi-Fi".into(),
            mac: None,
        }
    }

    /// Blocks until the plugin answers: never call on the UI thread.
    pub fn scan(app: &AppHandle) -> Result<ScanOutput, String> {
        #[derive(Deserialize)]
        struct Out {
            bss: Vec<wifi_core::RawBss>,
            warnings: Vec<String>,
        }
        let o: Out = app
            .state::<Scanner>()
            .0
            .run_mobile_plugin("scan", ())
            .map_err(|e| e.to_string())?;
        Ok(ScanOutput {
            interface: "wlan0".into(),
            bss: o.bss,
            warnings: o.warnings,
        })
    }

    #[derive(Deserialize)]
    struct Status {
        status: String,
    }

    /// authorized / denied / notDetermined, like the macOS backend.
    pub async fn permission_status(app: &AppHandle) -> Result<String, String> {
        let s: Status = app
            .state::<Scanner>()
            .0
            .run_mobile_plugin_async("permissionStatus", ())
            .await
            .map_err(|e| e.to_string())?;
        Ok(s.status)
    }

    pub async fn request_access(app: &AppHandle) -> Result<(), String> {
        app.state::<Scanner>()
            .0
            .run_mobile_plugin_async::<Status>("requestAccess", ())
            .await
            .map(drop)
            .map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(android::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let oui = std::fs::read_to_string(data_dir(app.handle()).join("oui.csv"))
                .ok()
                .map(|t| OuiDb::from_ieee_csv(&t));
            *app.state::<AppState>().oui.lock().unwrap() = oui;
            // macOS: SSID/BSSID are redacted without Location Services. setup() runs on the main thread.
            wifi_scan::request_location_permission();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform_info,
            list_interfaces,
            probe_info,
            scan,
            update_oui_db,
            save_text,
            autosave_write,
            save_bytes,
            autosave_read,
            request_location,
            #[cfg(desktop)]
            check_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running WiFiSight");
}
