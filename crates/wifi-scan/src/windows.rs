//! Windows backend: Native Wifi API (wlanapi.dll).
//!
//! Windows 11 24H2+ requires "Let desktop apps access your location" for the
//! BSS list; otherwise WlanGetNetworkBssList fails with ERROR_ACCESS_DENIED.

use crate::{Interface, ScanError, ScanOptions, ScanOutput};
use std::time::Duration;
use wifi_core::RawBss;
use windows::core::GUID;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::NetworkManagement::WiFi::*;

const ERROR_ACCESS_DENIED: u32 = 5;
const ERROR_SUCCESS: u32 = 0;

struct Client(HANDLE);

impl Drop for Client {
    fn drop(&mut self) {
        unsafe {
            WlanCloseHandle(self.0, None);
        }
    }
}

fn open() -> Result<Client, ScanError> {
    let mut negotiated = 0u32;
    let mut h = HANDLE::default();
    let r = unsafe { WlanOpenHandle(2, None, &mut negotiated, &mut h) };
    if r != ERROR_SUCCESS {
        return Err(ScanError::Os(format!(
            "WlanOpenHandle failed ({r}); is the WLAN AutoConfig service running?"
        )));
    }
    Ok(Client(h))
}

fn wstr(s: &[u16]) -> String {
    let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
    String::from_utf16_lossy(&s[..end])
}

fn guid_str(g: &GUID) -> String {
    format!("{g:?}")
}

fn list_ifaces(c: &Client) -> Result<Vec<(GUID, String)>, ScanError> {
    let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
    let r = unsafe { WlanEnumInterfaces(c.0, None, &mut list) };
    if r != ERROR_SUCCESS || list.is_null() {
        return Err(ScanError::Os(format!("WlanEnumInterfaces failed ({r})")));
    }
    let mut out = Vec::new();
    unsafe {
        let n = (*list).dwNumberOfItems as usize;
        let first = std::ptr::addr_of!((*list).InterfaceInfo) as *const WLAN_INTERFACE_INFO;
        for i in 0..n {
            let info = &*first.add(i);
            out.push((info.InterfaceGuid, wstr(&info.strInterfaceDescription)));
        }
        WlanFreeMemory(list as *const _);
    }
    Ok(out)
}

pub fn interfaces() -> Result<Vec<Interface>, ScanError> {
    let c = open()?;
    Ok(list_ifaces(&c)?
        .into_iter()
        .map(|(g, desc)| Interface {
            id: guid_str(&g),
            name: desc.clone(),
            description: desc,
            mac: None,
        })
        .collect())
}

fn connected_bssid(c: &Client, g: &GUID) -> Option<[u8; 6]> {
    let mut size = 0u32;
    let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
    let r = unsafe {
        WlanQueryInterface(
            c.0,
            g,
            wlan_intf_opcode_current_connection,
            None,
            &mut size,
            &mut data,
            None,
        )
    };
    if r != ERROR_SUCCESS || data.is_null() {
        return None;
    }
    let bssid = unsafe {
        let attrs = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
        let b = attrs.wlanAssociationAttributes.dot11Bssid;
        WlanFreeMemory(data as *const _);
        b
    };
    Some(bssid)
}

pub fn scan(opts: &ScanOptions) -> Result<ScanOutput, ScanError> {
    let c = open()?;
    let ifs = list_ifaces(&c)?;
    let (guid, name) = match &opts.interface {
        Some(id) => ifs.iter().find(|(g, n)| &guid_str(g) == id || n == id),
        None => ifs.first(),
    }
    .cloned()
    .ok_or(ScanError::NoInterface)?;
    let mut warnings = Vec::new();

    if opts.trigger {
        let r = unsafe { WlanScan(c.0, &guid, None, None, None) };
        if r != ERROR_SUCCESS {
            warnings.push(format!("WlanScan failed ({r}); showing cached results"));
        } else if opts.wait {
            // Windows completes a scan in ~2-4 s; notifications would be exact but this is sufficient.
            std::thread::sleep(Duration::from_millis(3500));
        }
    }

    let mut list: *mut WLAN_BSS_LIST = std::ptr::null_mut();
    let r = unsafe {
        WlanGetNetworkBssList(c.0, &guid, None, dot11_BSS_type_any, false, None, &mut list)
    };
    if r == ERROR_ACCESS_DENIED {
        return Err(ScanError::Permission(
            "Windows blocks Wi-Fi scan results without location access. Enable Settings › Privacy & security › Location › \"Let desktop apps access your location\".".into(),
        ));
    }
    if r != ERROR_SUCCESS || list.is_null() {
        return Err(ScanError::Os(format!("WlanGetNetworkBssList failed ({r})")));
    }
    let connected = connected_bssid(&c, &guid);
    let mut bss = Vec::new();
    unsafe {
        let n = (*list).dwNumberOfItems as usize;
        let first = std::ptr::addr_of!((*list).wlanBssEntries) as *const WLAN_BSS_ENTRY;
        for i in 0..n {
            let e_ptr = first.add(i);
            let e = &*e_ptr;
            let ssid_len = (e.dot11Ssid.uSSIDLength as usize).min(32);
            let ies = if e.ulIeSize > 0 {
                let p = (e_ptr as *const u8).add(e.ulIeOffset as usize);
                std::slice::from_raw_parts(p, e.ulIeSize as usize).to_vec()
            } else {
                Vec::new()
            };
            bss.push(RawBss {
                bssid: e.dot11Bssid,
                ssid: Some(e.dot11Ssid.ucSSID[..ssid_len].to_vec()),
                freq_mhz: e.ulChCenterFrequency / 1000,
                rssi_dbm: e.lRssi,
                noise_dbm: None,
                beacon_interval_tu: Some(e.usBeaconPeriod),
                capability: Some(e.usCapabilityInformation),
                ies,
                age_ms: None,
                connected: connected == Some(e.dot11Bssid),
                os_channel_width_mhz: None,
                os_country: None,
            });
        }
        WlanFreeMemory(list as *const _);
    }
    Ok(ScanOutput {
        interface: name,
        bss,
        warnings,
    })
}
