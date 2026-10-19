//! macOS backend: CoreWLAN.
//!
//! Since macOS 14 SSID/BSSID are only returned when the *app bundle* has been
//! granted Location Services. The Tauri app requests it at start-up
//! (`NSLocationWhenInUseUsageDescription` is set in Info.plist). A bare CLI
//! binary cannot get this permission, so the CLI gets no networks (only a warning).

#![allow(deprecated)]

use crate::{Interface, LinkInfo, ScanError, ScanOptions, ScanOutput};
use objc2::rc::Retained;
use objc2::runtime::NSObjectProtocol;
use objc2::{msg_send, sel};
use objc2_core_location::CLLocationManager;
use objc2_core_wlan::{CWChannelBand, CWChannelWidth, CWInterface, CWNetwork, CWWiFiClient};
use objc2_foundation::NSString;
use std::cell::RefCell;
use wifi_core::{channel::channel_to_freq, Band, RawBss};

thread_local! {
    static LOCATION: RefCell<Option<Retained<CLLocationManager>>> = const { RefCell::new(None) };
}

pub fn request_location_permission() {
    unsafe {
        let m = CLLocationManager::new();
        m.requestWhenInUseAuthorization();
        LOCATION.with(|c| *c.borrow_mut() = Some(m));
    }
}

pub fn location_status() -> String {
    let v = unsafe { CLLocationManager::new().authorizationStatus().0 };
    match v {
        0 => "notDetermined",
        1 => "restricted",
        2 => "denied",
        3 | 4 => "authorized",
        _ => "unknown",
    }
    .to_string()
}

fn ns(s: Option<Retained<NSString>>) -> Option<String> {
    s.map(|s| s.to_string())
}

fn pick_interface(name: Option<&str>) -> Result<Retained<CWInterface>, ScanError> {
    unsafe {
        let client = CWWiFiClient::sharedWiFiClient();
        match name {
            Some(n) => client.interfaceWithName(Some(&NSString::from_str(n))),
            None => client.interface(),
        }
        .ok_or(ScanError::NoInterface)
    }
}

pub fn interfaces() -> Result<Vec<Interface>, ScanError> {
    unsafe {
        let client = CWWiFiClient::sharedWiFiClient();
        let list = client.interfaces().ok_or(ScanError::NoInterface)?;
        Ok(list
            .iter()
            .map(|i| {
                let name = ns(i.interfaceName()).unwrap_or_else(|| "en0".into());
                Interface {
                    id: name.clone(),
                    description: format!("CoreWLAN {}", name),
                    name,
                    mac: ns(i.hardwareAddress()),
                }
            })
            .collect())
    }
}

fn convert(n: &CWNetwork, connected_bssid: Option<&str>, redacted: &mut bool) -> Option<RawBss> {
    unsafe {
        let ch = n.wlanChannel()?;
        let num = ch.channelNumber();
        let band = match ch.channelBand() {
            CWChannelBand::Band2GHz => Band::B2g4,
            CWChannelBand::Band5GHz => Band::B5,
            CWChannelBand::Band6GHz => Band::B6,
            _ => {
                if num <= 14 {
                    Band::B2g4
                } else {
                    Band::B5
                }
            }
        };
        let width = match ch.channelWidth() {
            CWChannelWidth::Width40MHz => Some(40),
            CWChannelWidth::Width80MHz => Some(80),
            CWChannelWidth::Width160MHz => Some(160),
            _ => Some(20),
        };
        let freq = channel_to_freq(band, num as u32).unwrap_or(0);
        let ssid = n.ssidData().map(|d| d.to_vec());
        let bssid_s = ns(n.bssid());
        // Redacted by Location Services: SSID is nil too, so it would show up as a bogus "hidden" BSS.
        let Some(bssid) = bssid_s.as_deref().and_then(wifi_core::parse_mac) else {
            *redacted = true;
            return None;
        };
        let connected = match (connected_bssid, bssid_s.as_deref()) {
            (Some(c), Some(b)) => c.eq_ignore_ascii_case(b),
            _ => false,
        };
        let noise = n.noiseMeasurement() as i32;
        Some(RawBss {
            bssid,
            ssid,
            freq_mhz: freq,
            rssi_dbm: n.rssiValue() as i32,
            noise_dbm: if noise < 0 { Some(noise) } else { None },
            beacon_interval_tu: Some(n.beaconInterval() as u16).filter(|&b| b > 0),
            capability: None,
            ies: n
                .informationElementData()
                .map(|d| d.to_vec())
                .unwrap_or_default(),
            age_ms: None,
            connected,
            os_channel_width_mhz: width,
            os_country: ns(n.countryCode()),
        })
    }
}

pub fn scan(opts: &ScanOptions) -> Result<ScanOutput, ScanError> {
    let iface = pick_interface(opts.interface.as_deref())?;
    let mut warnings = Vec::new();
    unsafe {
        let name = ns(iface.interfaceName()).unwrap_or_else(|| "en0".into());
        let set = if opts.trigger {
            match iface.scanForNetworksWithName_error(None) {
                Ok(s) => Some(s),
                Err(e) => {
                    warnings.push(format!(
                        "scan failed ({}); showing cached results",
                        e.localizedDescription()
                    ));
                    iface.cachedScanResults()
                }
            }
        } else {
            iface.cachedScanResults()
        };
        let connected = ns(iface.bssid());
        let mut redacted = false;
        let bss: Vec<RawBss> = set
            .map(|s| {
                s.iter()
                    .filter_map(|n| convert(&n, connected.as_deref(), &mut redacted))
                    .collect()
            })
            .unwrap_or_default();
        if redacted {
            warnings.push(
                "Networks are hidden by macOS. Allow Location Services for this app (System Settings › Privacy & Security › Location Services).".into(),
            );
        }
        Ok(ScanOutput {
            interface: name,
            bss,
            warnings,
        })
    }
}

pub fn link(interface: Option<&str>) -> Result<Option<LinkInfo>, ScanError> {
    let iface = pick_interface(interface)?;
    unsafe {
        // BSSID is nil when not associated, and also without Location Services.
        let Some(bssid) = ns(iface.bssid()).as_deref().and_then(wifi_core::parse_mac) else {
            return Ok(None);
        };
        // ponytail: private CWInterface selectors (present on macOS 14–27). If Apple drops them,
        // respondsToSelector fails and MCS/NSS just become None. No RX rate selector exists.
        let private = |s| iface.respondsToSelector(s);
        let mcs = private(sel!(mcsIndex)).then(|| msg_send![&*iface, mcsIndex]);
        let nss = private(sel!(numberOfSpatialStreams))
            .then(|| msg_send![&*iface, numberOfSpatialStreams]);
        let rate = iface.transmitRate();
        let rssi = iface.rssiValue() as i32;
        Ok(Some(LinkInfo {
            bssid: wifi_core::fmt_mac(&bssid),
            ssid: ns(iface.ssid()),
            rssi_dbm: (rssi < 0).then_some(rssi),
            tx_mbps: (rate > 0.0).then_some(rate),
            rx_mbps: None,
            mcs: mcs.and_then(|v: u64| u8::try_from(v).ok()),
            nss: nss
                .and_then(|v: u64| u8::try_from(v).ok())
                .filter(|&n| n > 0),
        }))
    }
}
