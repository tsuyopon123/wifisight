//! Thin per-OS Wi-Fi scanners.
//!
//! Each backend returns [`wifi_core::RawBss`] (BSSID, frequency, RSSI, raw IEs);
//! all interpretation happens in `wifi-core`.
//!
//! | OS      | API                         | Notes |
//! |---------|-----------------------------|-------|
//! | macOS   | CoreWLAN (`CWInterface`)    | Needs Location Services permission, otherwise SSID/BSSID are nil |
//! | Windows | Native Wifi (`wlanapi.dll`) | Win11 24H2+: needs location permission for BSS list |
//! | Linux   | nl80211 (generic netlink)   | Triggering a scan needs CAP_NET_ADMIN; otherwise falls back to NetworkManager rescan / cached results |

use serde::{Deserialize, Serialize};
use wifi_core::RawBss;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as backend;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as backend;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as backend;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod backend {
    use super::*;
    pub fn interfaces() -> Result<Vec<Interface>, ScanError> {
        Err(ScanError::Unsupported)
    }
    pub fn scan(_: &ScanOptions) -> Result<ScanOutput, ScanError> {
        Err(ScanError::Unsupported)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interface {
    /// Identifier passed back in [`ScanOptions::interface`] (ifname on Linux/macOS, GUID on Windows)
    pub id: String,
    pub name: String,
    pub description: String,
    pub mac: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    /// Interface id; `None` = first/default Wi-Fi interface.
    pub interface: Option<String>,
    /// Actively trigger a new scan (vs. reading cached results).
    pub trigger: bool,
    /// Block until the triggered scan completes.
    pub wait: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOutput {
    pub interface: String,
    pub bss: Vec<RawBss>,
    /// Non-fatal problems (e.g. "scan trigger not permitted, showing cached results").
    pub warnings: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("no Wi-Fi interface found")]
    NoInterface,
    #[error("permission denied: {0}")]
    Permission(String),
    #[error("scanning is not supported on this platform")]
    Unsupported,
    #[error("{0}")]
    Os(String),
}

pub fn interfaces() -> Result<Vec<Interface>, ScanError> {
    backend::interfaces()
}

pub fn scan(opts: &ScanOptions) -> Result<ScanOutput, ScanError> {
    backend::scan(opts)
}

/// macOS only: ask for Location Services authorisation (no-op elsewhere).
/// Must be called on the main thread from an app bundle with
/// `NSLocationWhenInUseUsageDescription` in Info.plist.
pub fn request_location_permission() {
    #[cfg(target_os = "macos")]
    macos::request_location_permission();
}

/// Human-readable location-permission state (macOS), `None` when not applicable.
pub fn location_permission_status() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        Some(macos::location_status())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}
