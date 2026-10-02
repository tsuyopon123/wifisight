//! 802.11 Information Element parsing (IEEE 802.11-2020, 802.11ax-2021, 802.11be).

use crate::model::{hex, IeField, IeView};

pub const EID_SSID: u8 = 0;
pub const EID_SUPP_RATES: u8 = 1;
pub const EID_DS_PARAMS: u8 = 3;
pub const EID_TIM: u8 = 5;
pub const EID_COUNTRY: u8 = 7;
pub const EID_BSS_LOAD: u8 = 11;
pub const EID_POWER_CONSTRAINT: u8 = 32;
pub const EID_TPC_REPORT: u8 = 35;
pub const EID_HT_CAP: u8 = 45;
pub const EID_RSN: u8 = 48;
pub const EID_EXT_SUPP_RATES: u8 = 50;
pub const EID_MOBILITY_DOMAIN: u8 = 54;
pub const EID_HT_OP: u8 = 61;
pub const EID_RM_ENABLED_CAP: u8 = 70;
pub const EID_MULTIPLE_BSSID: u8 = 71;
pub const EID_INTERWORKING: u8 = 107;
pub const EID_ADV_PROTOCOL: u8 = 108;
pub const EID_ROAMING_CONSORTIUM: u8 = 111;
pub const EID_EXT_CAP: u8 = 127;
pub const EID_CISCO_CCX1: u8 = 133;
pub const EID_VHT_CAP: u8 = 191;
pub const EID_VHT_OP: u8 = 192;
pub const EID_TPE: u8 = 195;
pub const EID_RNR: u8 = 201;
pub const EID_VENDOR: u8 = 221;
pub const EID_EXTENSION: u8 = 255;

pub const EXT_HE_CAP: u8 = 35;
pub const EXT_HE_OP: u8 = 36;
pub const EXT_MU_EDCA: u8 = 38;
pub const EXT_SPATIAL_REUSE: u8 = 39;
pub const EXT_HE_6G_CAP: u8 = 59;
pub const EXT_EHT_OP: u8 = 106;
pub const EXT_MULTI_LINK: u8 = 107;
pub const EXT_EHT_CAP: u8 = 108;

pub const OUI_MICROSOFT: [u8; 3] = [0x00, 0x50, 0xf2];
pub const OUI_WFA: [u8; 3] = [0x50, 0x6f, 0x9a];
pub const OUI_IEEE: [u8; 3] = [0x00, 0x0f, 0xac];

#[derive(Debug, Clone, Copy)]
pub struct Element<'a> {
    pub id: u8,
    /// Element ID Extension (only for id 255)
    pub ext_id: Option<u8>,
    /// Body (for extension elements, excluding the ext id byte)
    pub data: &'a [u8],
    /// Complete body including ext id byte
    pub raw: &'a [u8],
}

#[derive(Debug, Clone, Default)]
pub struct Elements<'a> {
    pub list: Vec<Element<'a>>,
    /// Trailing bytes that could not be parsed (truncated element)
    pub truncated: bool,
}

impl<'a> Elements<'a> {
    pub fn parse(buf: &'a [u8]) -> Self {
        let mut list = Vec::new();
        let mut i = 0usize;
        let mut truncated = false;
        while i + 2 <= buf.len() {
            let id = buf[i];
            let len = buf[i + 1] as usize;
            if i + 2 + len > buf.len() {
                truncated = true;
                break;
            }
            let raw = &buf[i + 2..i + 2 + len];
            let (ext_id, data) = if id == EID_EXTENSION && !raw.is_empty() {
                (Some(raw[0]), &raw[1..])
            } else {
                (None, raw)
            };
            list.push(Element {
                id,
                ext_id,
                data,
                raw,
            });
            i += 2 + len;
        }
        if i < buf.len() && !truncated {
            truncated = true;
        }
        Elements { list, truncated }
    }

    pub fn get(&self, id: u8) -> Option<&'a [u8]> {
        self.list
            .iter()
            .find(|e| e.id == id && e.ext_id.is_none())
            .map(|e| e.data)
    }

    pub fn get_ext(&self, ext: u8) -> Option<&'a [u8]> {
        self.list
            .iter()
            .find(|e| e.ext_id == Some(ext))
            .map(|e| e.data)
    }

    pub fn vendor(&self, oui: [u8; 3], vtype: u8) -> Option<&'a [u8]> {
        self.list
            .iter()
            .find(|e| {
                e.id == EID_VENDOR && e.data.len() >= 4 && e.data[..3] == oui && e.data[3] == vtype
            })
            .map(|e| &e.data[4..])
    }

    pub fn vendors(&self) -> impl Iterator<Item = &'a [u8]> + '_ {
        self.list
            .iter()
            .filter(|e| e.id == EID_VENDOR)
            .map(|e| e.data)
    }
}

// ───────────────────────── typed decoders ─────────────────────────

#[derive(Debug, Clone, Default)]
pub struct HtCap {
    pub info: u16,
    pub width40: bool,
    pub sgi20: bool,
    pub sgi40: bool,
    pub nss: u8,
}

pub fn ht_cap(d: &[u8]) -> Option<HtCap> {
    if d.len() < 26 {
        return None;
    }
    let info = u16::from_le_bytes([d[0], d[1]]);
    let mcs = &d[3..13];
    let nss = mcs[..4].iter().filter(|&&b| b != 0).count() as u8;
    Some(HtCap {
        info,
        width40: info & 0x0002 != 0,
        sgi20: info & 0x0020 != 0,
        sgi40: info & 0x0040 != 0,
        nss,
    })
}

#[derive(Debug, Clone, Default)]
pub struct HtOp {
    pub primary: u8,
    /// 0 = none, 1 = above, 3 = below
    pub secondary_offset: u8,
    pub sta_width_any: bool,
}

pub fn ht_op(d: &[u8]) -> Option<HtOp> {
    if d.len() < 22 {
        return None;
    }
    Some(HtOp {
        primary: d[0],
        secondary_offset: d[1] & 0x03,
        sta_width_any: d[1] & 0x04 != 0,
    })
}

/// Decode a 16-bit MCS map with 2 bits per NSS (VHT / HE).
/// `max_for` maps the 2-bit code to max MCS (None = not supported).
pub fn mcs_map_nss(map: u16, max_for: impl Fn(u16) -> Option<u8>) -> (u8, u8) {
    let mut nss = 0u8;
    let mut mcs = 0u8;
    for i in 0..8 {
        let code = (map >> (i * 2)) & 0x3;
        if let Some(m) = max_for(code) {
            nss = i as u8 + 1;
            mcs = mcs.max(m);
        }
    }
    (nss, mcs)
}

#[derive(Debug, Clone, Default)]
pub struct VhtCap {
    pub info: u32,
    pub supported_width_set: u8,
    pub sgi80: bool,
    pub sgi160: bool,
    pub nss: u8,
    pub max_mcs: u8,
}

pub fn vht_cap(d: &[u8]) -> Option<VhtCap> {
    if d.len() < 12 {
        return None;
    }
    let info = u32::from_le_bytes([d[0], d[1], d[2], d[3]]);
    let rx_map = u16::from_le_bytes([d[4], d[5]]);
    let (nss, max_mcs) = mcs_map_nss(rx_map, |c| match c {
        0 => Some(7),
        1 => Some(8),
        2 => Some(9),
        _ => None,
    });
    Some(VhtCap {
        info,
        supported_width_set: ((info >> 2) & 0x3) as u8,
        sgi80: info & (1 << 5) != 0,
        sgi160: info & (1 << 6) != 0,
        nss,
        max_mcs,
    })
}

#[derive(Debug, Clone, Default)]
pub struct VhtOp {
    pub width: u8,
    pub ccfs0: u8,
    pub ccfs1: u8,
}

pub fn vht_op(d: &[u8]) -> Option<VhtOp> {
    if d.len() < 5 {
        return None;
    }
    Some(VhtOp {
        width: d[0],
        ccfs0: d[1],
        ccfs1: d[2],
    })
}

#[derive(Debug, Clone, Default)]
pub struct HeCap {
    pub width_set: u8,
    pub nss: u8,
    pub max_mcs: u8,
    pub nss160: Option<u8>,
}

pub fn he_cap(d: &[u8]) -> Option<HeCap> {
    // MAC cap (6) + PHY cap (11) + Rx/Tx MCS ≤80 (4)
    if d.len() < 21 {
        return None;
    }
    let phy = &d[6..17];
    let width_set = (phy[0] >> 1) & 0x7f;
    let code = |c: u16| match c {
        0 => Some(7),
        1 => Some(9),
        2 => Some(11),
        _ => None,
    };
    let (nss, max_mcs) = mcs_map_nss(u16::from_le_bytes([d[17], d[18]]), code);
    let nss160 = if width_set & 0x04 != 0 && d.len() >= 25 {
        Some(mcs_map_nss(u16::from_le_bytes([d[21], d[22]]), code).0)
    } else {
        None
    };
    Some(HeCap {
        width_set,
        nss,
        max_mcs,
        nss160,
    })
}

#[derive(Debug, Clone, Default)]
pub struct SixGhzOpInfo {
    pub primary: u8,
    pub width: u32,
    pub ccfs0: u8,
    pub ccfs1: u8,
}

#[derive(Debug, Clone, Default)]
pub struct HeOp {
    pub params: u32,
    pub bss_color: u8,
    pub bss_color_disabled: bool,
    pub twt_required: bool,
    pub six_ghz: Option<SixGhzOpInfo>,
}

pub fn he_op(d: &[u8]) -> Option<HeOp> {
    if d.len() < 6 {
        return None;
    }
    let params = u32::from_le_bytes([d[0], d[1], d[2], 0]);
    let color = d[3];
    let mut off = 6;
    if params & (1 << 14) != 0 {
        off += 3;
    }
    if params & (1 << 15) != 0 {
        off += 1;
    }
    let six_ghz = if params & (1 << 17) != 0 && d.len() >= off + 5 {
        let w = match d[off + 1] & 0x3 {
            0 => 20,
            1 => 40,
            2 => 80,
            _ => 160,
        };
        Some(SixGhzOpInfo {
            primary: d[off],
            width: w,
            ccfs0: d[off + 2],
            ccfs1: d[off + 3],
        })
    } else {
        None
    };
    Some(HeOp {
        params,
        bss_color: color & 0x3f,
        bss_color_disabled: color & 0x80 != 0,
        twt_required: params & (1 << 3) != 0,
        six_ghz,
    })
}

#[derive(Debug, Clone, Default)]
pub struct EhtCap {
    pub supports_320: bool,
    pub nss: u8,
    pub max_mcs: u8,
}

/// `he_width_set` is needed because the EHT MCS map layout depends on it.
pub fn eht_cap(d: &[u8], he_width_set: u8) -> Option<EhtCap> {
    // MAC cap (2) + PHY cap (9) + ≥3 bytes MCS map
    if d.len() < 14 {
        return None;
    }
    let phy = &d[2..11];
    let supports_320 = phy[0] & 0x02 != 0;
    let _ = he_width_set;
    // ≤80 MHz map: 3 bytes (MCS 0-9, 10-11, 12-13), low nibble = Rx max NSS
    let m = &d[11..14];
    let nss = (m[0] & 0x0f).max(m[1] & 0x0f).max(m[2] & 0x0f);
    let max_mcs = if m[2] & 0x0f != 0 {
        13
    } else if m[1] & 0x0f != 0 {
        11
    } else {
        9
    };
    Some(EhtCap {
        supports_320,
        nss,
        max_mcs,
    })
}

#[derive(Debug, Clone, Default)]
pub struct EhtOp {
    pub width: Option<u32>,
    pub ccfs0: u8,
    pub ccfs1: u8,
    pub disabled_subchannels: Option<u16>,
}

pub fn eht_op(d: &[u8]) -> Option<EhtOp> {
    if d.len() < 5 {
        return None;
    }
    let params = d[0];
    if params & 0x01 != 0 && d.len() >= 8 {
        let w = match d[5] & 0x07 {
            0 => 20,
            1 => 40,
            2 => 80,
            3 => 160,
            4 => 320,
            _ => 20,
        };
        let dis = if params & 0x02 != 0 && d.len() >= 10 {
            Some(u16::from_le_bytes([d[8], d[9]]))
        } else {
            None
        };
        Some(EhtOp {
            width: Some(w),
            ccfs0: d[6],
            ccfs1: d[7],
            disabled_subchannels: dis,
        })
    } else {
        Some(EhtOp::default())
    }
}

pub fn rates(d: &[u8]) -> (Vec<f32>, Vec<f32>) {
    let mut basic = Vec::new();
    let mut all = Vec::new();
    for &b in d {
        // 0xff/0xfe etc. are BSS membership selectors (HT/VHT/SAE-H2E…)
        let v = b & 0x7f;
        if matches!(v, 0x7f | 0x7e | 0x7b | 0x7a | 0x79) {
            continue;
        }
        let r = v as f32 * 0.5;
        all.push(r);
        if b & 0x80 != 0 {
            basic.push(r);
        }
    }
    (basic, all)
}

pub fn ext_cap_bit(d: &[u8], bit: usize) -> bool {
    d.get(bit / 8)
        .map(|b| b & (1 << (bit % 8)) != 0)
        .unwrap_or(false)
}

pub fn country(d: &[u8]) -> Option<String> {
    if d.len() < 2 {
        return None;
    }
    let s: String = d[..2].iter().map(|&c| c as char).collect();
    if s.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(s)
    } else {
        None
    }
}

pub fn roaming_consortium(d: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    if d.len() < 2 {
        return out;
    }
    let l1 = (d[1] & 0x0f) as usize;
    let l2 = (d[1] >> 4) as usize;
    let mut off = 2;
    for l in [l1, l2] {
        if l == 0 || off + l > d.len() {
            break;
        }
        out.push(hex(&d[off..off + l]).to_uppercase());
        off += l;
    }
    // Any remaining bytes after the listed OIs are ignored (spec allows only 2 in-beacon OIs)
    out
}

/// Known RCOIs (Roaming Consortium OIs) useful at events.
pub fn rcoi_label(oi: &str) -> Option<&'static str> {
    let o = oi.to_uppercase();
    if o.starts_with("5A03BA") {
        Some("OpenRoaming (settlement-free)")
    } else if o.starts_with("BAA2D0") {
        Some("OpenRoaming (settled)")
    } else if o == "001BC50460" {
        Some("eduroam")
    } else {
        None
    }
}

/// Best-effort AP name extraction (Cisco CCX1 element 133, then vendor IEs).
pub fn ap_name(els: &Elements) -> Option<String> {
    let ccx1 = els
        .get(EID_CISCO_CCX1)
        .and_then(|d| d.get(10..26))
        .map(printable);
    ccx1.filter(|s| !s.is_empty())
        .or_else(|| els.vendors().find_map(vendor_ap_name))
}

/// AP name carried in one vendor-specific IE body (OUI, type, payload).
/// Usually off by default ("advertise AP name" per SSID); layouts follow Wireshark's packet-ieee80211.c.
pub fn vendor_ap_name(v: &[u8]) -> Option<String> {
    let (oui, t, p) = (v.get(..3)?, *v.get(3)?, &v[4..]);
    let name = match (oui, t) {
        // type, then the name up to the end of the IE
        ([0x00, 0x40, 0x96], 0x2f) // Cisco WLC / Meraki "AP name v2" (no CCX needed)
        | ([0x00, 0x15, 0x6d], 0x01) // Ubiquiti UniFi
        | ([0x5c, 0x5b, 0x35], 0x01) // Juniper Mist
        | ([0x00, 0x13, 0x92], 0x03) // Ruckus
        | ([0x00, 0x11, 0x74], 0x06) // Arista (Mojo)
        | ([0xdc, 0x08, 0x56], 0x01) // Alcatel-Lucent
        | ([0x84, 0x80, 0x94], 0x00) // Meter
        | ([0x48, 0xd0, 0x17], 0x02) // Telecom Infra Project
        | ([0x3c, 0xb9, 0xa6], 0x01) => p, // Belden
        // type, subtype, one unknown byte, then the name
        ([0x00, 0x0b, 0x86], 0x01) if p.first() == Some(&0x03) => p.get(2..)?, // Aruba (seen on AP-535)
        ([0x00, 0xe0, 0xfc], _) if p.first() == Some(&0x01) => p.get(2..)?,    // Huawei (any type)
        // Aerohive: type 33, version, subtype, length-prefixed name
        ([0x00, 0x19, 0x77], 33) => len_prefixed(p.get(2..)?)?,
        // Extreme WiNG: type 1, 7 unknown bytes, length-prefixed name
        ([0x00, 0xa0, 0xf8], 0x01) => len_prefixed(p.get(7..)?)?,
        // Fortinet: u16 LE subtype 10 (SYSTEM), then type/length TLVs; 1 = AP name
        ([0x00, 0x09, 0x0f], 10) if p.first() == Some(&0) => tlv(&p[1..], 1)?,
        _ => return None,
    };
    Some(printable(name)).filter(|s| !s.is_empty())
}

/// One length byte, then that many bytes (clamped to what is there, like Wireshark).
fn len_prefixed(b: &[u8]) -> Option<&[u8]> {
    let (&n, rest) = b.split_first()?;
    Some(&rest[..rest.len().min(n as usize)])
}

/// Value of the first 1-byte-type / 1-byte-length TLV of type `want`.
fn tlv(mut b: &[u8], want: u8) -> Option<&[u8]> {
    while let [t, n, rest @ ..] = b {
        let (v, next) = rest.split_at(rest.len().min(*n as usize));
        if *t == want {
            return Some(v);
        }
        b = next;
    }
    None
}

fn printable(b: &[u8]) -> String {
    let s: String = b
        .iter()
        .take_while(|&&c| c != 0)
        .filter(|c| c.is_ascii_graphic() || **c == b' ')
        .map(|&c| c as char)
        .collect();
    s.trim().to_string()
}

/// WPS (Microsoft OUI type 4) Manufacturer and "Model Name Model Number" — consumer routers fill these in.
pub fn wps_info(els: &Elements) -> (Option<String>, Option<String>) {
    // A WPS attribute set may be split over several vendor IEs; concatenate them.
    let body: Vec<u8> = els
        .vendors()
        .filter(|v| v.len() >= 4 && v[..3] == OUI_MICROSOFT && v[3] == 4)
        .flat_map(|v| v[4..].iter().copied())
        .collect();
    let (mut manuf, mut name, mut num) = (None, None, None);
    let mut i = 0;
    while i + 4 <= body.len() {
        let t = u16::from_be_bytes([body[i], body[i + 1]]);
        let l = u16::from_be_bytes([body[i + 2], body[i + 3]]) as usize;
        let Some(v) = body.get(i + 4..i + 4 + l) else {
            break;
        };
        let s = Some(printable(v)).filter(|s| !s.is_empty());
        match t {
            0x1021 => manuf = s,
            0x1023 => name = s,
            0x1024 => num = s,
            _ => {}
        }
        i += 4 + l;
    }
    let model = match (name, num) {
        (Some(n), Some(m)) if !n.contains(&m) => Some(format!("{n} {m}")),
        (n, m) => n.or(m),
    };
    (manuf, model)
}

/// Vendor-IE OUIs that say nothing about who made the AP: standards bodies, or the radio chipset (`Some(true)`).
pub fn non_ap_oui(oui: &[u8]) -> Option<bool> {
    match oui {
        [0x00, 0x50, 0xf2] | [0x50, 0x6f, 0x9a] | [0x00, 0x0f, 0xac] => Some(false),
        [0x00, 0x10, 0x18]
        | [0x00, 0x90, 0x4c]
        | [0x00, 0x03, 0x7f]
        | [0x8c, 0xfd, 0xf0]
        | [0x00, 0x0c, 0x43]
        | [0x00, 0x0c, 0xe7]
        | [0x00, 0xe0, 0x4c]
        | [0x00, 0x26, 0x86] => Some(true),
        _ => None,
    }
}

pub fn vendor_oui_name(oui: &[u8]) -> Option<&'static str> {
    Some(match oui {
        [0x00, 0x50, 0xf2] => "Microsoft",
        [0x50, 0x6f, 0x9a] => "Wi-Fi Alliance",
        [0x00, 0x0f, 0xac] => "IEEE 802.11",
        [0x00, 0x40, 0x96] => "Cisco",
        [0x00, 0x18, 0x0a] => "Cisco Meraki",
        [0x00, 0x0b, 0x86] => "Aruba (HPE)",
        [0x00, 0x10, 0x18] => "Broadcom",
        [0x00, 0x90, 0x4c] => "Broadcom (Epigram)",
        [0x00, 0x03, 0x7f] => "Qualcomm Atheros",
        [0x8c, 0xfd, 0xf0] => "Qualcomm",
        [0x00, 0x0c, 0x43] => "MediaTek (Ralink)",
        [0x00, 0x0c, 0xe7] => "MediaTek",
        [0x00, 0x17, 0xf2] => "Apple",
        [0x00, 0x13, 0x92] => "Ruckus",
        [0x00, 0x15, 0x6d] => "Ubiquiti",
        [0x5c, 0x5b, 0x35] => "Juniper Mist",
        [0x00, 0x11, 0x74] => "Arista (Mojo)",
        [0x00, 0x19, 0x77] => "Aerohive (Extreme)",
        [0x00, 0xa0, 0xf8] => "Extreme WiNG (Zebra)",
        [0x00, 0x09, 0x0f] => "Fortinet",
        [0x00, 0xe0, 0xfc] => "Huawei",
        [0xdc, 0x08, 0x56] => "Alcatel-Lucent",
        [0x00, 0xe0, 0x4c] => "Realtek",
        [0x00, 0x26, 0x86] => "Quantenna",
        _ => return None,
    })
}

pub fn vendor_ie_label(v: &[u8]) -> String {
    if v.len() < 3 {
        return "Vendor Specific (short)".into();
    }
    let oui = &v[..3];
    let t = v.get(3).copied();
    let specific = match (oui, t) {
        ([0x00, 0x50, 0xf2], Some(1)) => Some("WPA"),
        ([0x00, 0x50, 0xf2], Some(2)) => Some("WMM/WME"),
        ([0x00, 0x50, 0xf2], Some(4)) => Some("WPS"),
        ([0x50, 0x6f, 0x9a], Some(0x09)) => Some("P2P"),
        ([0x50, 0x6f, 0x9a], Some(0x10)) => Some("Hotspot 2.0 (Passpoint)"),
        ([0x50, 0x6f, 0x9a], Some(0x16)) => Some("MBO-OCE"),
        ([0x50, 0x6f, 0x9a], Some(0x1c)) => Some("OWE Transition Mode"),
        _ => None,
    };
    let org = vendor_oui_name(oui)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{:02x}:{:02x}:{:02x}", oui[0], oui[1], oui[2]));
    match (specific, t) {
        (Some(s), _) => format!("{org}: {s}"),
        (None, Some(t)) => format!("{org} (type {t})"),
        (None, None) => org,
    }
}

pub fn element_name(id: u8, ext: Option<u8>) -> String {
    if let Some(x) = ext {
        return match x {
            EXT_HE_CAP => "HE Capabilities".into(),
            EXT_HE_OP => "HE Operation".into(),
            EXT_MU_EDCA => "MU EDCA Parameter Set".into(),
            EXT_SPATIAL_REUSE => "Spatial Reuse Parameter Set".into(),
            EXT_HE_6G_CAP => "HE 6 GHz Band Capabilities".into(),
            EXT_EHT_OP => "EHT Operation".into(),
            EXT_MULTI_LINK => "Multi-Link".into(),
            EXT_EHT_CAP => "EHT Capabilities".into(),
            55 => "UL OFDMA-based Random Access".into(),
            _ => format!("Extension {x}"),
        };
    }
    match id {
        EID_SSID => "SSID",
        EID_SUPP_RATES => "Supported Rates",
        EID_DS_PARAMS => "DS Parameter Set",
        EID_TIM => "TIM",
        EID_COUNTRY => "Country",
        EID_BSS_LOAD => "BSS Load",
        EID_POWER_CONSTRAINT => "Power Constraint",
        EID_TPC_REPORT => "TPC Report",
        42 => "ERP Information",
        EID_HT_CAP => "HT Capabilities",
        46 => "QoS Capability",
        EID_RSN => "RSN",
        EID_EXT_SUPP_RATES => "Extended Supported Rates",
        EID_MOBILITY_DOMAIN => "Mobility Domain (11r)",
        EID_HT_OP => "HT Operation",
        EID_RM_ENABLED_CAP => "RM Enabled Capabilities (11k)",
        EID_MULTIPLE_BSSID => "Multiple BSSID",
        74 => "Overlapping BSS Scan Parameters",
        EID_INTERWORKING => "Interworking",
        EID_ADV_PROTOCOL => "Advertisement Protocol",
        EID_ROAMING_CONSORTIUM => "Roaming Consortium",
        EID_EXT_CAP => "Extended Capabilities",
        EID_CISCO_CCX1 => "Cisco CCX1 CKIP + Device Name",
        150 => "Cisco Unknown 150",
        EID_VHT_CAP => "VHT Capabilities",
        EID_VHT_OP => "VHT Operation",
        EID_TPE => "Transmit Power Envelope",
        EID_RNR => "Reduced Neighbor Report",
        199 => "Operating Mode Notification",
        EID_VENDOR => "Vendor Specific",
        _ => return format!("Element {id}"),
    }
    .to_string()
}

fn f(name: &str, value: impl Into<String>) -> IeField {
    IeField {
        name: name.into(),
        value: value.into(),
    }
}

fn width_name(w: u32) -> String {
    format!("{w} MHz")
}

fn mac_at(d: &[u8], i: usize) -> Option<String> {
    d.get(i..i + 6)
        .map(|m| crate::model::fmt_mac(&m.try_into().unwrap()))
}

/// (AP MLD MAC, Link ID) from a Basic Multi-Link element.
pub fn mld(d: &[u8]) -> Option<(String, Option<u8>)> {
    let ctl = u16::from_le_bytes([*d.first()?, *d.get(1)?]);
    if ctl & 0x7 != 0 {
        return None;
    }
    let link = (ctl & 0x10 != 0)
        .then(|| d.get(9).map(|b| b & 0x0f))
        .flatten();
    Some((mac_at(d, 3)?, link))
}

/// Multi-Link element (802.11be 9.4.2.312): control + Common Info. Per-STA profiles are not decoded.
fn multi_link_fields(d: &[u8]) -> Vec<IeField> {
    let mut v = Vec::new();
    if d.len() < 2 {
        return v;
    }
    let ctl = u16::from_le_bytes([d[0], d[1]]);
    let ty = ctl & 0x7;
    v.push(f(
        "Type",
        match ty {
            0 => "Basic",
            1 => "Probe Request",
            2 => "Reconfiguration",
            3 => "TDLS",
            4 => "Priority Access",
            _ => "reserved",
        },
    ));
    if ty != 0 {
        return v;
    }
    let has = |bit: u16| ctl & (1 << bit) != 0;
    let Some(mac) = mac_at(d, 3) else { return v };
    v.push(f("AP MLD MAC", mac));
    let mut i = 9; // ctl(2) + common info length(1) + MLD MAC(6)
    let mut take = |n: usize| {
        let s = d.get(i..i + n);
        i += n;
        s
    };
    if has(4) {
        if let Some(b) = take(1) {
            v.push(f("Link ID", (b[0] & 0x0f).to_string()));
        }
    }
    if has(5) {
        if let Some(b) = take(1) {
            v.push(f("BSS Params Change Count", b[0].to_string()));
        }
    }
    if has(6) {
        take(2); // Medium Synchronization Delay
    }
    if has(7) {
        if let Some(b) = take(2) {
            let eml = u16::from_le_bytes([b[0], b[1]]);
            v.push(f(
                "EMLSR / EMLMR",
                format!("{} / {}", yn(eml & 1 != 0), yn(eml & 0x80 != 0)),
            ));
        }
    }
    if has(8) {
        if let Some(b) = take(2) {
            // field holds (max simultaneous links − 1)
            v.push(f("Max Simultaneous Links", ((b[0] & 0x0f) + 1).to_string()));
        }
    }
    if has(9) {
        if let Some(b) = take(1) {
            v.push(f("AP MLD ID", b[0].to_string()));
        }
    }
    v
}

fn op_class_band(op: u8) -> &'static str {
    match op {
        81..=84 => "2.4 GHz",
        115..=130 => "5 GHz",
        131..=137 => "6 GHz",
        _ => "?",
    }
}

/// Reduced Neighbor Report (9.4.2.170): one field per neighbor AP (co-located 6 GHz / MLO links).
fn rnr_fields(d: &[u8]) -> Vec<IeField> {
    let mut v = Vec::new();
    let mut i = 0;
    while i + 4 <= d.len() {
        let hdr = u16::from_le_bytes([d[i], d[i + 1]]);
        let count = ((hdr >> 4) & 0xf) as usize + 1;
        let len = (hdr >> 8) as usize;
        let (op, ch) = (d[i + 2], d[i + 3]);
        i += 4;
        // TBTT Information layout is selected by its length (Table 9-283 + 802.11be MLD params)
        let (bssid, sssid, params, mld) = match len {
            2 => (false, false, true, false),
            5 => (false, true, false, false),
            6 => (false, true, true, false),
            7 => (true, false, false, false),
            8 | 9 => (true, false, true, false),
            11 => (true, true, false, false),
            12 | 13 => (true, true, true, false),
            l if l >= 16 => (true, true, true, true),
            _ => (false, false, false, false),
        };
        for _ in 0..count {
            let Some(t) = d.get(i..i + len) else { return v };
            i += len;
            let mut s = format!("{} ch {ch}", op_class_band(op));
            let mut j = 1; // skip Neighbor AP TBTT Offset, then walk to BSS Parameters
            if bssid {
                s += &format!(" {}", mac_at(t, 1).unwrap_or_default());
                j += 6;
            }
            if sssid {
                j += 4;
            }
            if params {
                let p = t[j];
                for (bit, name) in [(1, "same SSID"), (6, "co-located")] {
                    if p & (1 << bit) != 0 {
                        s += &format!(", {name}");
                    }
                }
            }
            // MLD Parameters sit after offset, BSSID, short SSID, BSS params, PSD; AP MLD ID 255 = not an MLD
            if mld && t[13] != 0xff {
                s += &format!(", MLD {} link {}", t[13], t[14] & 0x0f);
            }
            v.push(f("Neighbor AP", s));
        }
    }
    v
}

/// Human-readable decode of every element, for the details pane.
pub fn describe_all(els: &Elements) -> Vec<IeView> {
    let he_width_set = els
        .get_ext(EXT_HE_CAP)
        .and_then(he_cap)
        .map(|c| c.width_set)
        .unwrap_or(0);
    els.list
        .iter()
        .map(|e| {
            let mut fields = Vec::new();
            let d = e.data;
            match (e.id, e.ext_id) {
                (EID_SSID, _) => {
                    fields.push(f("SSID", String::from_utf8_lossy(d).to_string()));
                }
                (EID_SUPP_RATES, _) | (EID_EXT_SUPP_RATES, _) => {
                    let (b, a) = rates(d);
                    fields.push(f("Rates (Mbps)", fmt_rates(&a)));
                    fields.push(f("Basic", fmt_rates(&b)));
                }
                (EID_DS_PARAMS, _) if !d.is_empty() => {
                    fields.push(f("Current Channel", d[0].to_string()))
                }
                (EID_TIM, _) if d.len() >= 3 => {
                    fields.push(f("DTIM Count", d[0].to_string()));
                    fields.push(f("DTIM Period", d[1].to_string()));
                }
                (EID_COUNTRY, _) if d.len() >= 3 => {
                    fields.push(f("Country", country(d).unwrap_or_default()));
                    fields.push(f("Environment", format!("0x{:02x}", d[2])));
                    for t in d[3..].chunks(3).filter(|t| t.len() == 3 && t[0] < 201) {
                        fields.push(f(
                            "Triplet",
                            format!("first ch {} / {} ch / max {} dBm", t[0], t[1], t[2] as i8),
                        ));
                    }
                }
                (EID_BSS_LOAD, _) if d.len() >= 5 => {
                    fields.push(f(
                        "Station Count",
                        u16::from_le_bytes([d[0], d[1]]).to_string(),
                    ));
                    fields.push(f(
                        "Channel Utilization",
                        format!("{:.1} % ({}/255)", d[2] as f32 / 2.55, d[2]),
                    ));
                    fields.push(f(
                        "Avail. Admission Capacity",
                        format!("{} ×32µs/s", u16::from_le_bytes([d[3], d[4]])),
                    ));
                }
                (EID_POWER_CONSTRAINT, _) if !d.is_empty() => {
                    fields.push(f("Local Power Constraint", format!("{} dB", d[0])))
                }
                (EID_TPC_REPORT, _) if d.len() >= 2 => {
                    fields.push(f("Transmit Power", format!("{} dBm", d[0] as i8)));
                    fields.push(f("Link Margin", format!("{} dB", d[1] as i8)));
                }
                (EID_HT_CAP, _) => {
                    if let Some(c) = ht_cap(d) {
                        fields.push(f("Capability Info", format!("0x{:04x}", c.info)));
                        fields.push(f("40 MHz Supported", yn(c.width40)));
                        fields.push(f("SGI 20/40", format!("{}/{}", yn(c.sgi20), yn(c.sgi40))));
                        fields.push(f("Spatial Streams", c.nss.to_string()));
                    }
                }
                (EID_HT_OP, _) => {
                    if let Some(o) = ht_op(d) {
                        fields.push(f("Primary Channel", o.primary.to_string()));
                        fields.push(f(
                            "Secondary Channel Offset",
                            match o.secondary_offset {
                                1 => "above",
                                3 => "below",
                                _ => "none",
                            },
                        ));
                        fields.push(f(
                            "STA Channel Width",
                            if o.sta_width_any { "any" } else { "20 MHz" },
                        ));
                    }
                }
                (EID_RSN, _) => {
                    if let Some(r) = crate::security::parse_rsn(d) {
                        fields.push(f("Version", r.version.to_string()));
                        fields.push(f("Group Cipher", r.group.clone().unwrap_or_default()));
                        fields.push(f("Pairwise Ciphers", r.pairwise.join(", ")));
                        fields.push(f("AKM Suites", r.akms.join(", ")));
                        fields.push(f("Capabilities", format!("0x{:04x}", r.caps)));
                        fields.push(f(
                            "MFP Required / Capable",
                            format!("{} / {}", yn(r.mfpr), yn(r.mfpc)),
                        ));
                        if let Some(g) = &r.group_mgmt {
                            fields.push(f("Group Mgmt Cipher", g.clone()));
                        }
                    }
                }
                (EID_MOBILITY_DOMAIN, _) if d.len() >= 3 => {
                    fields.push(f(
                        "MDID",
                        format!("0x{:04x}", u16::from_le_bytes([d[0], d[1]])),
                    ));
                    fields.push(f("FT over DS", yn(d[2] & 1 != 0)));
                }
                (EID_EXT_CAP, _) => {
                    let bits: &[(usize, &str)] = &[
                        (2, "Extended Channel Switching"),
                        (19, "BSS Transition (11v)"),
                        (31, "Interworking"),
                        (46, "WNM Notification"),
                        (62, "Opmode Notification"),
                        (77, "TWT Requester"),
                        (78, "TWT Responder"),
                    ];
                    let on: Vec<&str> = bits
                        .iter()
                        .filter(|(b, _)| ext_cap_bit(d, *b))
                        .map(|(_, n)| *n)
                        .collect();
                    fields.push(f(
                        "Enabled",
                        if on.is_empty() {
                            "-".into()
                        } else {
                            on.join(", ")
                        },
                    ));
                }
                (EID_INTERWORKING, _) if !d.is_empty() => {
                    let ant = d[0] & 0x0f;
                    let ant_s = match ant {
                        0 => "Private",
                        1 => "Private w/ guest",
                        2 => "Chargeable public",
                        3 => "Free public",
                        4 => "Personal device",
                        5 => "Emergency only",
                        14 => "Test",
                        15 => "Wildcard",
                        _ => "Reserved",
                    };
                    fields.push(f("Access Network Type", format!("{ant} ({ant_s})")));
                    fields.push(f("Internet", yn(d[0] & 0x10 != 0)));
                }
                (EID_ROAMING_CONSORTIUM, _) => {
                    if !d.is_empty() {
                        fields.push(f("ANQP OIs", d[0].to_string()));
                    }
                    for oi in roaming_consortium(d) {
                        let label = rcoi_label(&oi)
                            .map(|l| format!(" — {l}"))
                            .unwrap_or_default();
                        fields.push(f("OI", format!("{oi}{label}")));
                    }
                }
                (EID_CISCO_CCX1, _) if d.len() >= 26 => {
                    fields.push(f("Device Name", printable(&d[10..26])))
                }
                (EID_VHT_CAP, _) => {
                    if let Some(c) = vht_cap(d) {
                        fields.push(f("Capability Info", format!("0x{:08x}", c.info)));
                        fields.push(f(
                            "Supported Width Set",
                            match c.supported_width_set {
                                0 => "80 MHz",
                                1 => "160 MHz",
                                2 => "160, 80+80 MHz",
                                _ => "reserved",
                            },
                        ));
                        fields.push(f("SGI 80/160", format!("{}/{}", yn(c.sgi80), yn(c.sgi160))));
                        fields.push(f("Rx NSS / Max MCS", format!("{} / {}", c.nss, c.max_mcs)));
                    }
                }
                (EID_VHT_OP, _) => {
                    if let Some(o) = vht_op(d) {
                        fields.push(f(
                            "Channel Width",
                            match o.width {
                                0 => "20/40 MHz",
                                1 => "80/160/80+80 MHz",
                                2 => "160 MHz (deprecated)",
                                3 => "80+80 MHz (deprecated)",
                                _ => "reserved",
                            },
                        ));
                        fields.push(f("CCFS0", o.ccfs0.to_string()));
                        fields.push(f("CCFS1", o.ccfs1.to_string()));
                    }
                }
                (EID_VENDOR, _) => {
                    fields.push(f("Type", vendor_ie_label(d)));
                    if let Some(n) = vendor_ap_name(d) {
                        fields.push(f("AP Name", n));
                    }
                    if d.len() > 3 && d[..3] == OUI_MICROSOFT && d[3] == 2 && d.len() > 6 {
                        fields.push(f("WMM Subtype", d[4].to_string()));
                    }
                }
                (EID_RNR, _) => fields = rnr_fields(d),
                (_, Some(EXT_MULTI_LINK)) => fields = multi_link_fields(d),
                (_, Some(EXT_HE_CAP)) => {
                    if let Some(c) = he_cap(d) {
                        let mut w = vec![];
                        if c.width_set & 0x01 != 0 {
                            w.push("40 MHz (2.4 GHz)");
                        }
                        if c.width_set & 0x02 != 0 {
                            w.push("40/80 MHz (5/6 GHz)");
                        }
                        if c.width_set & 0x04 != 0 {
                            w.push("160 MHz");
                        }
                        if c.width_set & 0x08 != 0 {
                            w.push("80+80 MHz");
                        }
                        fields.push(f(
                            "Channel Width Set",
                            if w.is_empty() {
                                "20 MHz".into()
                            } else {
                                w.join(", ")
                            },
                        ));
                        fields.push(f(
                            "Rx NSS / Max MCS (≤80)",
                            format!("{} / {}", c.nss, c.max_mcs),
                        ));
                        if let Some(n) = c.nss160 {
                            fields.push(f("Rx NSS (160)", n.to_string()));
                        }
                    }
                }
                (_, Some(EXT_HE_OP)) => {
                    if let Some(o) = he_op(d) {
                        fields.push(f(
                            "BSS Color",
                            format!(
                                "{}{}",
                                o.bss_color,
                                if o.bss_color_disabled {
                                    " (disabled)"
                                } else {
                                    ""
                                }
                            ),
                        ));
                        fields.push(f("TWT Required", yn(o.twt_required)));
                        if let Some(s) = &o.six_ghz {
                            fields.push(f("6 GHz Primary Channel", s.primary.to_string()));
                            fields.push(f("6 GHz Channel Width", width_name(s.width)));
                            fields.push(f(
                                "6 GHz CCFS0 / CCFS1",
                                format!("{} / {}", s.ccfs0, s.ccfs1),
                            ));
                        }
                    }
                }
                (_, Some(EXT_EHT_CAP)) => {
                    if let Some(c) = eht_cap(d, he_width_set) {
                        fields.push(f("320 MHz (6 GHz)", yn(c.supports_320)));
                        fields.push(f(
                            "Rx NSS / Max MCS (≤80)",
                            format!("{} / {}", c.nss, c.max_mcs),
                        ));
                    }
                }
                (_, Some(EXT_EHT_OP)) => {
                    if let Some(o) = eht_op(d) {
                        if let Some(w) = o.width {
                            fields.push(f("Channel Width", width_name(w)));
                            fields.push(f("CCFS0 / CCFS1", format!("{} / {}", o.ccfs0, o.ccfs1)));
                        }
                        if let Some(b) = o.disabled_subchannels {
                            fields
                                .push(f("Disabled Subchannels (puncturing)", format!("0x{b:04x}")));
                        }
                    }
                }
                _ => {}
            }
            IeView {
                id: e.id,
                ext_id: e.ext_id,
                name: element_name(e.id, e.ext_id),
                length: e.raw.len(),
                hex: hex(e.raw),
                fields,
            }
        })
        .collect()
}

fn yn(b: bool) -> &'static str {
    if b {
        "yes"
    } else {
        "no"
    }
}

fn fmt_rates(r: &[f32]) -> String {
    r.iter()
        .map(|x| {
            if x.fract() == 0.0 {
                format!("{x:.0}")
            } else {
                format!("{x}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aruba_ap_name() {
        // Real beacon from an Aruba AP-535 (unnamed AP => name is its MAC)
        let mut buf = vec![221u8, 23, 0x00, 0x0b, 0x86, 0x01, 0x03, 0x00];
        buf.extend_from_slice(b"f0:61:c0:ce:97:ea");
        assert_eq!(
            ap_name(&Elements::parse(&buf)).as_deref(),
            Some("f0:61:c0:ce:97:ea")
        );
    }

    #[test]
    fn unifi_ap_name() {
        let mut buf = vec![221u8, 10, 0x00, 0x15, 0x6d, 0x01];
        buf.extend_from_slice(b"U7-Pro");
        assert_eq!(ap_name(&Elements::parse(&buf)).as_deref(), Some("U7-Pro"));
        // type 0 (UUID blob, always sent) is not a name
        let buf = [221u8, 8, 0x00, 0x15, 0x6d, 0x00, b'a', b'b', b'c', b'd'];
        assert_eq!(ap_name(&Elements::parse(&buf)), None);
    }

    #[test]
    fn vendor_ap_names() {
        let cases: &[(&[u8], &str)] = &[
            (b"\x00\x40\x96\x2fMR46-Lobby", "MR46-Lobby"),
            (b"\x5c\x5b\x35\x01mist-ap", "mist-ap"),
            (b"\x00\x13\x92\x03R750-2F", "R750-2F"),
            (b"\x00\x11\x74\x06arista1", "arista1"),
            (b"\x00\xe0\xfc\x05\x01\x00hw-ap", "hw-ap"),
            (b"\x00\x19\x77\x21\x01\x00\x05ah-01xx", "ah-01"),
            (
                b"\x00\xa0\xf8\x01\x00\x00\x00\x00\x00\x00\x00\x04wing",
                "wing",
            ),
            // Fortinet: model TLV before name TLV
            (
                b"\x00\x09\x0f\x0a\x00\x02\x04FP23\x01\x05FAP-1\x03\x02SN",
                "FAP-1",
            ),
        ];
        for (v, want) in cases {
            assert_eq!(vendor_ap_name(v).as_deref(), Some(*want), "{v:02x?}");
        }
        // Meraki beacon with name broadcast off: Cisco type 0x2c is a flag, not a name
        assert_eq!(vendor_ap_name(b"\x00\x40\x96\x2c\x08"), None);
        // truncated length prefix is clamped, empty payloads are None
        assert_eq!(
            vendor_ap_name(b"\x00\x19\x77\x21\x01\x00\x09ab").as_deref(),
            Some("ab")
        );
        assert_eq!(vendor_ap_name(b"\x00\x13\x92\x03"), None);
        assert_eq!(vendor_ap_name(b"\x00\x13"), None);
    }

    #[test]
    fn parse_basic() {
        let buf = [0u8, 4, b't', b'e', b's', b't', 1, 2, 0x82, 0x84, 3, 1, 6];
        let els = Elements::parse(&buf);
        assert_eq!(els.list.len(), 3);
        assert!(!els.truncated);
        assert_eq!(els.get(EID_SSID).unwrap(), b"test");
        assert_eq!(els.get(EID_DS_PARAMS).unwrap(), &[6]);
    }

    #[test]
    fn truncated() {
        let buf = [0u8, 10, b'a'];
        let els = Elements::parse(&buf);
        assert!(els.truncated);
        assert!(els.list.is_empty());
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn vals(v: &[IeField]) -> Vec<String> {
        v.iter()
            .map(|x| format!("{}={}", x.name, x.value))
            .collect()
    }

    #[test]
    fn multi_link_and_rnr() {
        // Real beacons from a Wi-Fi 7 MLO AP (5 GHz link 0 + 6 GHz link 1), captured with MT7925
        let ml = unhex("b0010d8c3066825f7400db01402100");
        assert_eq!(
            vals(&multi_link_fields(&ml)),
            [
                "Type=Basic",
                "AP MLD MAC=8c:30:66:82:5f:74",
                "Link ID=0",
                "BSS Params Change Count=219",
                "EMLSR / EMLMR=yes / no",
                "Max Simultaneous Links=2",
            ]
        );
        // 5 GHz beacon: 4 neighbors on 6 GHz ch 53, only the last is our MLD's other link
        let rnr = unhex("30108635ff8c3066825f77473246e04814ffff0fff923066825f773a9364d74814ffff0fff9a3066825f77b9abfec94814ffff0fff963066825f77510d49434a14000100");
        let r = vals(&rnr_fields(&rnr));
        assert_eq!(r.len(), 4);
        assert_eq!(
            r[0],
            "Neighbor AP=6 GHz ch 53 8c:30:66:82:5f:77, co-located"
        );
        assert_eq!(
            r[3],
            "Neighbor AP=6 GHz ch 53 96:30:66:82:5f:77, same SSID, co-located, MLD 0 link 1"
        );
        // 2.4 GHz beacon: 13-byte TBTT info (no MLD params)
        let rnr = unhex("300d8635ff8c3066825f77473246e04814ff923066825f773a9364d74814ff9a3066825f77b9abfec94814ff963066825f77510d49434814");
        assert_eq!(rnr_fields(&rnr).len(), 4);
        // truncated input must not panic
        assert_eq!(rnr_fields(&rnr[..20]).len(), 1); // first entry fits, the rest is cut
        assert_eq!(vals(&multi_link_fields(&ml[..5])), ["Type=Basic"]);
        assert_eq!(mld(&ml), Some(("8c:30:66:82:5f:74".into(), Some(0))));
        assert_eq!(mld(&ml[..5]), None);
    }

    #[test]
    fn rcoi() {
        let d = [
            0u8, 0x55, 0x5a, 0x03, 0xba, 0x00, 0x00, 0x00, 0x1b, 0xc5, 0x04, 0x60,
        ];
        let o = roaming_consortium(&d);
        assert_eq!(o, vec!["5A03BA0000", "001BC50460"]);
        assert_eq!(rcoi_label(&o[1]), Some("eduroam"));
    }
}
