use crate::channel::{band_of, channel_to_freq, freq_to_channel};
use crate::ie::{self, Elements};
use crate::model::*;
use crate::oui::{is_locally_administered, OuiDb};
use crate::rates::{rate, Phy};
use crate::security::classify;

/// Turn a scanner result into a fully analysed [`BssInfo`].
pub fn analyze(raw: &RawBss, oui: Option<&OuiDb>) -> BssInfo {
    let els = Elements::parse(&raw.ies);

    // ── SSID ──
    let ssid_bytes: Vec<u8> = raw
        .ssid
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| els.get(ie::EID_SSID).map(|s| s.to_vec()))
        .unwrap_or_default();
    let hidden = ssid_bytes.is_empty() || ssid_bytes.iter().all(|&b| b == 0);
    let ssid = if hidden {
        String::new()
    } else {
        String::from_utf8_lossy(&ssid_bytes).to_string()
    };

    // ── Channel / width ──
    let band = band_of(raw.freq_mhz);
    let channel = freq_to_channel(raw.freq_mhz)
        .or_else(|| {
            els.get(ie::EID_DS_PARAMS)
                .and_then(|d| d.first())
                .map(|&c| c as u32)
        })
        .unwrap_or(0);
    let (width, center) = channel_geometry(&els, band, channel, raw.os_channel_width_mhz);
    let center_freq = channel_to_freq(band, center).unwrap_or(raw.freq_mhz);
    let (freq_low, freq_high) = if band == Band::B2g4 && width == 20 {
        // DSSS/OFDM 20 MHz-ish mask; draw 22 MHz wide like most tools
        (center_freq - 11, center_freq + 11)
    } else {
        (center_freq - width / 2, center_freq + width / 2)
    };

    // ── Capabilities ──
    let (basic_a, sup_a) = els
        .get(ie::EID_SUPP_RATES)
        .map(ie::rates)
        .unwrap_or_default();
    let (basic_b, sup_b) = els
        .get(ie::EID_EXT_SUPP_RATES)
        .map(ie::rates)
        .unwrap_or_default();
    let mut basic_rates: Vec<f32> = basic_a.into_iter().chain(basic_b).collect();
    let mut supported_rates: Vec<f32> = sup_a.into_iter().chain(sup_b).collect();
    basic_rates.sort_by(|a, b| a.partial_cmp(b).unwrap());
    supported_rates.sort_by(|a, b| a.partial_cmp(b).unwrap());
    supported_rates.dedup();

    let ht = els.get(ie::EID_HT_CAP).and_then(ie::ht_cap);
    let vht = els.get(ie::EID_VHT_CAP).and_then(ie::vht_cap);
    let he = els.get_ext(ie::EXT_HE_CAP).and_then(ie::he_cap);
    let he_op = els.get_ext(ie::EXT_HE_OP).and_then(ie::he_op);
    let eht = els
        .get_ext(ie::EXT_EHT_CAP)
        .and_then(|d| ie::eht_cap(d, he.as_ref().map(|h| h.width_set).unwrap_or(0)));

    let mut phy_modes = Vec::new();
    match band {
        Band::B2g4 => {
            let b_rates = [1.0f32, 2.0, 5.5, 11.0];
            if supported_rates.iter().any(|r| b_rates.contains(r)) || supported_rates.is_empty() {
                phy_modes.push("b".to_string());
            }
            if supported_rates.iter().any(|r| !b_rates.contains(r)) {
                phy_modes.push("g".to_string());
            }
        }
        Band::B5 => phy_modes.push("a".into()),
        _ => {}
    }
    if ht.is_some() && band != Band::B6 {
        phy_modes.push("n".into());
    }
    if vht.is_some() && band == Band::B5 {
        phy_modes.push("ac".into());
    }
    if he.is_some() {
        phy_modes.push("ax".into());
    }
    if eht.is_some() {
        phy_modes.push("be".into());
    }
    let generation = if eht.is_some() {
        "Wi-Fi 7 (802.11be)"
    } else if he.is_some() {
        if band == Band::B6 {
            "Wi-Fi 6E (802.11ax)"
        } else {
            "Wi-Fi 6 (802.11ax)"
        }
    } else if vht.is_some() && band == Band::B5 {
        "Wi-Fi 5 (802.11ac)"
    } else if ht.is_some() {
        "Wi-Fi 4 (802.11n)"
    } else {
        "Legacy (802.11a/b/g)"
    }
    .to_string();

    // ── Max PHY rate ──
    let (max_rate, nss) = if let Some(e) = &eht {
        let nss = if e.nss > 0 {
            e.nss
        } else {
            he.as_ref().map(|h| h.nss).unwrap_or(1)
        };
        (
            Some(rate(Phy::Eht, width.min(320), e.max_mcs, nss, true)),
            Some(nss),
        )
    } else if let Some(h) = &he {
        let w = width.min(160);
        let nss = if w == 160 {
            h.nss160.filter(|&n| n > 0).unwrap_or(h.nss)
        } else {
            h.nss
        };
        (Some(rate(Phy::He, w, h.max_mcs, nss, true)), Some(nss))
    } else if let (Some(v), Band::B5) = (&vht, band) {
        let w = width.min(160);
        let mut mcs = v.max_mcs;
        if w == 20 && mcs == 9 {
            mcs = 8;
        }
        let sgi = match w {
            160 => v.sgi160,
            80 => v.sgi80,
            40 => ht.as_ref().map(|h| h.sgi40).unwrap_or(false),
            _ => ht.as_ref().map(|h| h.sgi20).unwrap_or(false),
        };
        (Some(rate(Phy::Vht, w, mcs, v.nss, sgi)), Some(v.nss))
    } else if let Some(h) = &ht {
        let w = if width >= 40 && h.width40 { 40 } else { 20 };
        let sgi = if w == 40 { h.sgi40 } else { h.sgi20 };
        (
            Some(rate(Phy::Ht, w, 7, h.nss.max(1), sgi)),
            Some(h.nss.max(1)),
        )
    } else {
        (
            supported_rates
                .iter()
                .cloned()
                .fold(None, |m: Option<f32>, r| Some(m.map_or(r, |x| x.max(r))))
                .map(|r| r as f64),
            Some(1),
        )
    };
    let max_rate = max_rate.map(|r| (r * 10.0).round() / 10.0);

    // ── Misc elements ──
    let security = classify(&els, raw.capability);
    let bss_load = els
        .get(ie::EID_BSS_LOAD)
        .filter(|d| d.len() >= 5)
        .map(|d| BssLoad {
            station_count: u16::from_le_bytes([d[0], d[1]]),
            channel_utilization_pct: (d[2] as f64 / 255.0 * 1000.0).round() / 10.0,
            available_admission_capacity: u16::from_le_bytes([d[3], d[4]]),
        });
    let country = els
        .get(ie::EID_COUNTRY)
        .and_then(ie::country)
        .or_else(|| raw.os_country.clone());
    let tx_power_dbm = els
        .get(ie::EID_TPC_REPORT)
        .and_then(|d| d.first())
        .map(|&b| b as i8);
    let ext_cap = els.get(ie::EID_EXT_CAP).unwrap_or(&[]);

    let features = Features {
        rrm_11k: els.get(ie::EID_RM_ENABLED_CAP).is_some(),
        ft_11r: els.get(ie::EID_MOBILITY_DOMAIN).is_some()
            || security.akms.iter().any(|a| a.starts_with("FT-")),
        bss_transition_11v: ie::ext_cap_bit(ext_cap, 19),
        wmm: els.vendor(ie::OUI_MICROSOFT, 2).is_some(),
        wps: els.vendor(ie::OUI_MICROSOFT, 4).is_some(),
        passpoint: els.vendor(ie::OUI_WFA, 0x10).is_some(),
        interworking: els.get(ie::EID_INTERWORKING).is_some(),
        owe_transition: els.vendor(ie::OUI_WFA, 0x1c).is_some(),
        mbo: els.vendor(ie::OUI_WFA, 0x16).is_some(),
        multiple_bssid: els.get(ie::EID_MULTIPLE_BSSID).is_some(),
        multi_link: els.get_ext(ie::EXT_MULTI_LINK).is_some(),
        twt_required: he_op.as_ref().map(|o| o.twt_required).unwrap_or(false),
    };

    let mut vendor_ies: Vec<String> = els.vendors().map(ie::vendor_ie_label).collect();
    vendor_ies.dedup();

    let locally_administered = is_locally_administered(&raw.bssid);
    let (wps_manuf, model) = ie::wps_info(&els);
    let oui_name = |o: &[u8]| -> Option<String> {
        let m = [o[0], o[1], o[2], 0, 0, 0];
        oui.and_then(|db| db.lookup(&m))
            .or_else(|| ie::vendor_oui_name(o))
            .map(str::to_string)
    };
    // Vendor IE OUIs: AP makers first, radio chipsets only as a last resort.
    let ie_vendor = |chipset: bool| {
        els.vendors().find_map(|v| {
            let o = v.get(..3)?;
            if ie::non_ap_oui(o) != chipset.then_some(true) {
                return None;
            }
            oui_name(o)
        })
    };
    let vendor = oui
        .and_then(|db| db.lookup(&raw.bssid))
        .map(str::to_string)
        .or_else(|| {
            els.get(ie::EID_CISCO_CCX1)
                .map(|_| "Cisco (IE)".to_string())
        })
        .or_else(|| wps_manuf.map(|m| format!("{m} (WPS)")))
        .or_else(|| ie_vendor(false).map(|n| format!("{n} (IE)")))
        .or_else(|| {
            // Multi-BSSID APs often derive extra BSSIDs by setting the U/L bit on their own OUI.
            // ponytail: a random (tethering) MAC can hit a real OUI this way (~1%), hence the "?".
            let mut m = raw.bssid;
            m[0] &= !0x02;
            let name = oui.filter(|_| locally_administered)?.lookup(&m)?;
            Some(format!("{name} ?"))
        })
        .or_else(|| ie_vendor(true).map(|n| format!("{n} chipset")));

    let (mld, mld_link_id) = els.get_ext(ie::EXT_MULTI_LINK).and_then(ie::mld).unzip();
    let noise = raw.noise_dbm.filter(|&n| n < 0 && n > -130);

    BssInfo {
        bssid: fmt_mac(&raw.bssid),
        ssid,
        hidden,
        vendor,
        locally_administered,
        ap_name: ie::ap_name(&els),
        model,
        band,
        freq_mhz: raw.freq_mhz,
        channel,
        center_channel: center,
        center_freq_mhz: center_freq,
        width_mhz: width,
        freq_low_mhz: freq_low,
        freq_high_mhz: freq_high,
        rssi_dbm: raw.rssi_dbm,
        noise_dbm: noise,
        snr_db: noise.map(|n| raw.rssi_dbm - n),
        phy_modes,
        generation,
        max_rate_mbps: max_rate,
        spatial_streams: nss,
        basic_rates,
        supported_rates,
        security,
        beacon_interval_tu: raw.beacon_interval_tu,
        capability: raw.capability,
        country,
        bss_load,
        bss_color: he_op
            .as_ref()
            .filter(|o| !o.bss_color_disabled)
            .map(|o| o.bss_color),
        tx_power_dbm,
        features,
        roaming_consortium: els
            .get(ie::EID_ROAMING_CONSORTIUM)
            .map(ie::roaming_consortium)
            .unwrap_or_default(),
        vendor_ies,
        ies: ie::describe_all(&els),
        age_ms: raw.age_ms,
        connected: raw.connected,
        mld,
        mld_link_id: mld_link_id.flatten(),
    }
}

/// Returns (width MHz, center channel number).
fn channel_geometry(els: &Elements, band: Band, primary: u32, os_width: Option<u32>) -> (u32, u32) {
    let mut width = 20u32;
    let mut center = primary;
    let mut from_ie = false;

    if let Some(h) = els.get(ie::EID_HT_OP).and_then(ie::ht_op) {
        from_ie = true;
        if h.sta_width_any {
            match h.secondary_offset {
                1 => {
                    width = 40;
                    center = primary + 2;
                }
                3 => {
                    width = 40;
                    center = primary.saturating_sub(2);
                }
                _ => {}
            }
        }
    }
    if band == Band::B5 {
        if let Some(v) = els.get(ie::EID_VHT_OP).and_then(ie::vht_op) {
            from_ie = true;
            let (c0, c1) = (v.ccfs0 as u32, v.ccfs1 as u32);
            match v.width {
                1 => {
                    if c1 == 0 {
                        width = 80;
                        center = c0;
                    } else if c0.abs_diff(c1) == 8 {
                        width = 160;
                        center = c1;
                    } else {
                        // 80+80: show primary 80 segment
                        width = 80;
                        center = c0;
                    }
                }
                2 => {
                    width = 160;
                    center = c0;
                }
                3 => {
                    width = 80;
                    center = c0;
                }
                _ => {}
            }
        }
    }
    if band == Band::B6 {
        if let Some(s) = els
            .get_ext(ie::EXT_HE_OP)
            .and_then(ie::he_op)
            .and_then(|o| o.six_ghz)
        {
            from_ie = true;
            width = s.width;
            center = match s.width {
                20 => s.primary as u32,
                160 if s.ccfs1 != 0 => s.ccfs1 as u32,
                _ => s.ccfs0 as u32,
            };
        }
    }
    if let Some(e) = els.get_ext(ie::EXT_EHT_OP).and_then(ie::eht_op) {
        if let Some(w) = e.width {
            from_ie = true;
            if w > width {
                width = w;
                center = match w {
                    320 | 160 if e.ccfs1 != 0 => e.ccfs1 as u32,
                    _ => e.ccfs0 as u32,
                };
            }
        }
    }
    if !from_ie {
        if let Some(w) = os_width.filter(|&w| w > 20) {
            width = w;
            center = aligned_center(band, primary, w).unwrap_or(primary);
        }
    }
    if center == 0 {
        center = primary;
    }
    (width, center)
}

/// Standard channelisation when only the width is known (macOS without IEs).
pub fn aligned_center(band: Band, primary: u32, width: u32) -> Option<u32> {
    match band {
        Band::B5 => {
            let centers: &[u32] = match width {
                40 => &[
                    38, 46, 54, 62, 102, 110, 118, 126, 134, 142, 151, 159, 167, 175,
                ],
                80 => &[42, 58, 106, 122, 138, 155, 171],
                160 => &[50, 114, 163],
                _ => return None,
            };
            let half = width / 10; // channel numbers per half-width (5 MHz per number)
            centers
                .iter()
                .copied()
                .find(|&c| primary + half > c && primary < c + half)
        }
        Band::B6 => {
            let n = width / 20;
            if n == 0 || primary == 0 {
                return None;
            }
            let step = n * 4;
            let start = 1 + ((primary - 1) / step) * step;
            Some(start + (n - 1) * 2)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ie_builder::IeBuilder;

    fn raw(freq: u32, ies: Vec<u8>) -> RawBss {
        RawBss {
            bssid: [0x00, 0x11, 0x22, 0x33, 0x44, 0x55],
            freq_mhz: freq,
            rssi_dbm: -55,
            noise_dbm: Some(-92),
            capability: Some(0x0011),
            ies,
            ..Default::default()
        }
    }

    #[test]
    fn aligned() {
        assert_eq!(aligned_center(Band::B5, 36, 80), Some(42));
        assert_eq!(aligned_center(Band::B5, 48, 80), Some(42));
        assert_eq!(aligned_center(Band::B5, 149, 80), Some(155));
        assert_eq!(aligned_center(Band::B5, 100, 160), Some(114));
        assert_eq!(aligned_center(Band::B6, 37, 160), Some(47));
        assert_eq!(aligned_center(Band::B6, 1, 320), Some(31));
    }

    #[test]
    fn vht80() {
        let ies = IeBuilder::new()
            .ssid("lab")
            .rates_5g()
            .ht_cap(2, true)
            .ht_op(36, 1)
            .vht_cap(2)
            .vht_op(1, 42, 0)
            .rsn(&[2, 8], 0x80)
            .build();
        let b = analyze(&raw(5180, ies), None);
        assert_eq!(b.channel, 36);
        assert_eq!(b.width_mhz, 80);
        assert_eq!(b.center_channel, 42);
        assert_eq!(b.freq_low_mhz, 5170);
        assert_eq!(b.freq_high_mhz, 5250);
        assert_eq!(b.phy_modes, vec!["a", "n", "ac"]);
        assert_eq!(b.max_rate_mbps, Some(866.7));
        assert_eq!(b.security.label, "WPA2/WPA3-Personal");
        assert_eq!(b.snr_db, Some(37));
    }

    #[test]
    fn vht160() {
        let ies = IeBuilder::new()
            .ht_op(100, 1)
            .vht_cap(4)
            .vht_op(1, 106, 114)
            .build();
        let b = analyze(&raw(5500, ies), None);
        assert_eq!((b.width_mhz, b.center_channel), (160, 114));
    }

    #[test]
    fn he_6ghz_and_eht() {
        let ies = IeBuilder::new()
            .ssid("w7")
            .he_cap(2, 0x06)
            .he_op(5, Some((37, 160, 39, 47)))
            .eht_cap(2, true)
            .eht_op(320, 39, 31)
            .rsn(&[8, 24], 0xc0)
            .build();
        let b = analyze(&raw(6135, ies), None);
        assert_eq!(b.band, Band::B6);
        assert_eq!(b.channel, 37);
        assert_eq!(b.width_mhz, 320);
        assert_eq!(b.center_channel, 31);
        assert_eq!(b.generation, "Wi-Fi 7 (802.11be)");
        assert_eq!(b.bss_color, Some(5));
        assert_eq!(b.security.label, "WPA3-Personal");
        assert_eq!(b.max_rate_mbps, Some(5764.7));
    }

    #[test]
    fn ht40_24() {
        let ies = IeBuilder::new()
            .ssid("x")
            .rates_24g()
            .ht_cap(2, true)
            .ht_op(6, 3)
            .build();
        let b = analyze(&raw(2437, ies), None);
        assert_eq!((b.width_mhz, b.center_channel), (40, 4));
        assert_eq!(b.phy_modes, vec!["b", "g", "n"]);
        assert_eq!(b.max_rate_mbps, Some(300.0));
    }

    #[test]
    fn hidden_and_features() {
        let ies = IeBuilder::new()
            .ssid("")
            .rm_cap()
            .mobility_domain(0x1234)
            .ext_cap(&[19])
            .wmm()
            .bss_load(12, 128)
            .country("JP")
            .cisco_name("AP-HALL-A-01")
            .build();
        let b = analyze(&raw(5180, ies), None);
        assert!(b.hidden);
        assert!(
            b.features.rrm_11k
                && b.features.ft_11r
                && b.features.bss_transition_11v
                && b.features.wmm
        );
        assert_eq!(b.bss_load.as_ref().unwrap().station_count, 12);
        assert_eq!(b.country.as_deref(), Some("JP"));
        assert_eq!(b.ap_name.as_deref(), Some("AP-HALL-A-01"));
        assert_eq!(b.vendor.as_deref(), Some("Cisco (IE)"));
    }

    #[test]
    fn laa_vendor_guess() {
        let db = OuiDb::from_ieee_csv(
            "h\nMA-L,F061C0,\"Aruba, a Hewlett Packard Enterprise Company\",x\n",
        );
        let mut r = raw(5180, vec![]);
        r.bssid = [0xf2, 0x61, 0xc0, 0xce, 0x97, 0xea];
        let b = analyze(&r, Some(&db));
        assert_eq!(
            b.vendor.as_deref(),
            Some("Aruba, a Hewlett Packard Enterprise Company ?")
        );
        r.bssid = [0xf0, 0x61, 0xc0, 0xce, 0x97, 0xea];
        assert_eq!(
            analyze(&r, Some(&db)).vendor.as_deref(),
            Some("Aruba, a Hewlett Packard Enterprise Company")
        );
    }

    #[test]
    fn vendor_from_ies() {
        let la = |ies: &[&[u8]]| {
            let mut r = raw(
                2437,
                ies.iter()
                    .flat_map(|v| [&[221u8, v.len() as u8][..], v].concat())
                    .collect(),
            );
            r.bssid = [0x92, 0x30, 0x66, 0x82, 0x5f, 0x75];
            analyze(&r, None)
        };
        let qca: &[u8] = &[0x8c, 0xfd, 0xf0, 0x04, 0x01, 0x01, 0x02];
        let wmm: &[u8] = &[0x00, 0x50, 0xf2, 0x02, 0x01, 0x01, 0x00];
        // Real UniFi beacon: Ubiquiti IE after Qualcomm/WMM ones
        let ubnt: &[u8] = &[0x00, 0x15, 0x6d, 0x00, 0x01, 0x01, 0x00];
        let db = OuiDb::from_ieee_csv("h\nMA-L,00156D,Ubiquiti Inc,x\n");
        let mut r = raw(
            2437,
            [&[221u8, 7][..], qca, &[221, 7], wmm, &[221, 7], ubnt].concat(),
        );
        r.bssid = [0x92, 0x30, 0x66, 0x82, 0x5f, 0x75];
        assert_eq!(
            analyze(&r, Some(&db)).vendor.as_deref(),
            Some("Ubiquiti Inc (IE)")
        );
        // Only a chipset IE → last-resort hint
        assert_eq!(la(&[wmm, qca]).vendor.as_deref(), Some("Qualcomm chipset"));
        // WPS: Manufacturer 0x1021, Model Name 0x1023, Model Number 0x1024
        let wps: &[u8] = &[
            0x00, 0x50, 0xf2, 0x04, 0x10, 0x21, 0x00, 0x04, b'A', b'C', b'M', b'E', 0x10, 0x23,
            0x00, 0x02, b'R', b'X', 0x10, 0x24, 0x00, 0x01, b'9',
        ];
        let b = la(&[qca, wps]);
        assert_eq!(
            (b.vendor.as_deref(), b.model.as_deref()),
            (Some("ACME (WPS)"), Some("RX 9"))
        );
    }

    #[test]
    fn os_width_fallback() {
        let mut r = raw(5745, vec![]);
        r.os_channel_width_mhz = Some(80);
        let b = analyze(&r, None);
        assert_eq!((b.width_mhz, b.center_channel), (80, 155));
    }
}
