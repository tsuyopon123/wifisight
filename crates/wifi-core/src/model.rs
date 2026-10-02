use serde::{Deserialize, Serialize};

/// What a platform scanner hands to the analyzer.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawBss {
    pub bssid: [u8; 6],
    /// SSID as reported by the OS. If `None`, the SSID element in `ies` is used.
    pub ssid: Option<Vec<u8>>,
    pub freq_mhz: u32,
    pub rssi_dbm: i32,
    pub noise_dbm: Option<i32>,
    pub beacon_interval_tu: Option<u16>,
    pub capability: Option<u16>,
    /// Raw information elements (beacon or probe response body after the fixed fields).
    #[serde(with = "hex_bytes")]
    pub ies: Vec<u8>,
    pub age_ms: Option<u32>,
    /// The interface is currently associated to this BSS.
    pub connected: bool,
    /// Fallbacks reported by the OS when IEs are not available.
    pub os_channel_width_mhz: Option<u32>,
    pub os_country: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Band {
    #[serde(rename = "2.4")]
    B2g4,
    #[serde(rename = "5")]
    B5,
    #[serde(rename = "6")]
    B6,
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BssLoad {
    pub station_count: u16,
    /// 0-100 %
    pub channel_utilization_pct: f64,
    pub available_admission_capacity: u16,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    /// Short label, e.g. "WPA2/WPA3-Personal", "OWE", "Open"
    pub label: String,
    pub akms: Vec<String>,
    pub pairwise: Vec<String>,
    pub group: Option<String>,
    pub group_mgmt: Option<String>,
    /// "required" | "capable" | "disabled"
    pub pmf: String,
    pub wpa1: bool,
    pub rsn: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// 802.11k (RM Enabled Capabilities present)
    pub rrm_11k: bool,
    /// 802.11r (Mobility Domain present)
    pub ft_11r: bool,
    /// 802.11v (BSS Transition bit in Extended Capabilities)
    pub bss_transition_11v: bool,
    pub wmm: bool,
    pub wps: bool,
    pub passpoint: bool,
    pub interworking: bool,
    pub owe_transition: bool,
    pub mbo: bool,
    pub multiple_bssid: bool,
    pub multi_link: bool,
    pub twt_required: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IeField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IeView {
    pub id: u8,
    pub ext_id: Option<u8>,
    pub name: String,
    pub length: usize,
    pub hex: String,
    pub fields: Vec<IeField>,
}

/// Fully analysed BSS, ready for display/export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BssInfo {
    pub bssid: String,
    pub ssid: String,
    pub hidden: bool,
    pub vendor: Option<String>,
    /// Locally administered (randomised / virtual) BSSID.
    pub locally_administered: bool,
    pub ap_name: Option<String>,
    /// WPS Model Name / Number.
    #[serde(default)]
    pub model: Option<String>,
    pub band: Band,
    pub freq_mhz: u32,
    pub channel: u32,
    pub center_channel: u32,
    pub center_freq_mhz: u32,
    pub width_mhz: u32,
    /// Occupied spectrum, for the spectrum view.
    pub freq_low_mhz: u32,
    pub freq_high_mhz: u32,
    pub rssi_dbm: i32,
    pub noise_dbm: Option<i32>,
    pub snr_db: Option<i32>,
    /// e.g. ["b","g","n","ax"]
    pub phy_modes: Vec<String>,
    /// e.g. "Wi-Fi 6 (802.11ax)"
    pub generation: String,
    pub max_rate_mbps: Option<f64>,
    pub spatial_streams: Option<u8>,
    pub basic_rates: Vec<f32>,
    pub supported_rates: Vec<f32>,
    pub security: Security,
    pub beacon_interval_tu: Option<u16>,
    pub capability: Option<u16>,
    pub country: Option<String>,
    pub bss_load: Option<BssLoad>,
    pub bss_color: Option<u8>,
    pub tx_power_dbm: Option<i8>,
    pub features: Features,
    pub roaming_consortium: Vec<String>,
    pub vendor_ies: Vec<String>,
    pub ies: Vec<IeView>,
    pub age_ms: Option<u32>,
    pub connected: bool,
    /// AP MLD MAC address (Wi-Fi 7 Multi-Link); links of one AP MLD share it.
    #[serde(default)]
    pub mld: Option<String>,
    #[serde(default)]
    pub mld_link_id: Option<u8>,
}

pub fn fmt_mac(b: &[u8; 6]) -> String {
    b.iter()
        .map(|x| format!("{x:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

pub fn parse_mac(s: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = s.split([':', '-']).collect();
    if parts.len() != 6 {
        return None;
    }
    let mut out = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        out[i] = u8::from_str_radix(p, 16).ok()?;
    }
    Some(out)
}

pub fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::hex(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<_>, _>>()
            .map_err(serde::de::Error::custom)
    }
}
