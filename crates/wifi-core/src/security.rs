use crate::ie::{Elements, EID_RSN, OUI_IEEE, OUI_MICROSOFT, OUI_WFA};
use crate::model::Security;

#[derive(Debug, Clone, Default)]
pub struct Rsn {
    pub version: u16,
    pub group: Option<String>,
    pub pairwise: Vec<String>,
    pub akms: Vec<String>,
    pub akm_ids: Vec<u8>,
    pub caps: u16,
    pub mfpr: bool,
    pub mfpc: bool,
    pub group_mgmt: Option<String>,
}

pub fn cipher_name(oui: &[u8], t: u8) -> String {
    if oui == OUI_IEEE || oui == OUI_MICROSOFT {
        match t {
            0 => "Use group",
            1 => "WEP-40",
            2 => "TKIP",
            4 => "CCMP-128",
            5 => "WEP-104",
            6 => "BIP-CMAC-128",
            7 => "Group addressed traffic not allowed",
            8 => "GCMP-128",
            9 => "GCMP-256",
            10 => "CCMP-256",
            11 => "BIP-GMAC-128",
            12 => "BIP-GMAC-256",
            13 => "BIP-CMAC-256",
            _ => return format!("cipher {t}"),
        }
        .into()
    } else {
        format!("{:02x}{:02x}{:02x}:{t}", oui[0], oui[1], oui[2])
    }
}

pub fn akm_name(oui: &[u8], t: u8) -> String {
    if oui == OUI_IEEE {
        match t {
            1 => "802.1X",
            2 => "PSK",
            3 => "FT-802.1X",
            4 => "FT-PSK",
            5 => "802.1X-SHA256",
            6 => "PSK-SHA256",
            7 => "TDLS",
            8 => "SAE",
            9 => "FT-SAE",
            10 => "AP PeerKey",
            11 => "802.1X Suite-B",
            12 => "802.1X Suite-B-192",
            13 => "FT-802.1X-SHA384",
            14 => "FILS-SHA256",
            15 => "FILS-SHA384",
            16 => "FT-FILS-SHA256",
            17 => "FT-FILS-SHA384",
            18 => "OWE",
            19 => "FT-PSK-SHA384",
            20 => "PSK-SHA384",
            22 => "802.1X-SHA384",
            24 => "SAE-EXT-KEY",
            25 => "FT-SAE-EXT-KEY",
            _ => return format!("AKM {t}"),
        }
        .into()
    } else if oui == OUI_WFA && t == 1 {
        "OSEN".into()
    } else if oui == OUI_MICROSOFT {
        match t {
            1 => "802.1X (WPA)".into(),
            2 => "PSK (WPA)".into(),
            _ => format!("WPA AKM {t}"),
        }
    } else {
        format!("{:02x}{:02x}{:02x}:{t}", oui[0], oui[1], oui[2])
    }
}

fn suite(d: &[u8], off: usize) -> Option<(&[u8], u8)> {
    if d.len() >= off + 4 {
        Some((&d[off..off + 3], d[off + 3]))
    } else {
        None
    }
}

/// Parse an RSN element body (also works for the WPA1 vendor IE body after OUI+type).
pub fn parse_rsn(d: &[u8]) -> Option<Rsn> {
    if d.len() < 2 {
        return None;
    }
    let mut r = Rsn {
        version: u16::from_le_bytes([d[0], d[1]]),
        ..Default::default()
    };
    let mut off = 2;
    // Defaults per spec when fields are absent: CCMP group/pairwise, 802.1X AKM.
    match suite(d, off) {
        Some((o, t)) => {
            r.group = Some(cipher_name(o, t));
            off += 4;
        }
        None => return Some(r),
    }
    if d.len() < off + 2 {
        return Some(r);
    }
    let n = u16::from_le_bytes([d[off], d[off + 1]]) as usize;
    off += 2;
    for _ in 0..n {
        if let Some((o, t)) = suite(d, off) {
            r.pairwise.push(cipher_name(o, t));
        }
        off += 4;
    }
    if d.len() < off + 2 {
        return Some(r);
    }
    let n = u16::from_le_bytes([d[off], d[off + 1]]) as usize;
    off += 2;
    for _ in 0..n {
        if let Some((o, t)) = suite(d, off) {
            r.akms.push(akm_name(o, t));
            if o == OUI_IEEE {
                r.akm_ids.push(t);
            } else if o == OUI_MICROSOFT {
                // map WPA1 AKMs onto IEEE ids for classification
                r.akm_ids.push(t);
            }
        }
        off += 4;
    }
    if d.len() >= off + 2 {
        r.caps = u16::from_le_bytes([d[off], d[off + 1]]);
        r.mfpr = r.caps & (1 << 6) != 0;
        r.mfpc = r.caps & (1 << 7) != 0;
        off += 2;
        // PMKID count + list
        if d.len() >= off + 2 {
            let n = u16::from_le_bytes([d[off], d[off + 1]]) as usize;
            off += 2 + n * 16;
            if let Some((o, t)) = suite(d, off) {
                r.group_mgmt = Some(cipher_name(o, t));
            }
        }
    }
    Some(r)
}

pub fn classify(els: &Elements, capability: Option<u16>) -> Security {
    let privacy = capability.map(|c| c & 0x0010 != 0).unwrap_or(false);
    let rsn = els.get(EID_RSN).and_then(parse_rsn);
    let wpa = els.vendor(OUI_MICROSOFT, 1).and_then(parse_rsn);
    let owe_transition = els.vendor(OUI_WFA, 0x1c).is_some();

    let mut sec = Security {
        pmf: "disabled".into(),
        ..Default::default()
    };

    if let Some(r) = &rsn {
        sec.rsn = true;
        sec.akms = r.akms.clone();
        sec.pairwise = r.pairwise.clone();
        sec.group = r.group.clone();
        sec.group_mgmt = r.group_mgmt.clone();
        sec.pmf = if r.mfpr {
            "required".into()
        } else if r.mfpc {
            "capable".into()
        } else {
            "disabled".into()
        };
    }
    if let Some(w) = &wpa {
        sec.wpa1 = true;
        if rsn.is_none() {
            sec.akms = w.akms.clone();
            sec.pairwise = w.pairwise.clone();
            sec.group = w.group.clone();
        }
    }

    let has = |ids: &[u8]| {
        rsn.as_ref()
            .map(|r| r.akm_ids.iter().any(|a| ids.contains(a)))
            .unwrap_or(false)
    };
    let psk = has(&[2, 4, 6, 19, 20]);
    let sae = has(&[8, 9, 24, 25]);
    let eap = has(&[1, 3, 5, 13, 22]);
    let eap_sha256 = has(&[5]);
    let suite_b = has(&[11, 12]);
    let owe = has(&[18]);
    let osen = rsn
        .as_ref()
        .map(|r| r.akms.iter().any(|a| a == "OSEN"))
        .unwrap_or(false);
    let mfpr = sec.pmf == "required";

    sec.label = if rsn.is_some() {
        if suite_b {
            "WPA3-Enterprise 192-bit".into()
        } else if sae && psk {
            "WPA2/WPA3-Personal".into()
        } else if sae {
            "WPA3-Personal".into()
        } else if psk {
            if sec.wpa1 {
                "WPA/WPA2-Personal".into()
            } else {
                "WPA2-Personal".into()
            }
        } else if owe {
            "OWE".into()
        } else if eap {
            if eap_sha256 && mfpr && !has(&[1]) {
                "WPA3-Enterprise".into()
            } else if eap_sha256 || mfpr {
                "WPA2/WPA3-Enterprise".into()
            } else if sec.wpa1 {
                "WPA/WPA2-Enterprise".into()
            } else {
                "WPA2-Enterprise".into()
            }
        } else if osen {
            "OSEN".into()
        } else {
            "RSN (other)".into()
        }
    } else if let Some(w) = &wpa {
        if w.akm_ids.contains(&2) {
            "WPA-Personal".into()
        } else {
            "WPA-Enterprise".into()
        }
    } else if privacy {
        "WEP".into()
    } else if owe_transition {
        "Open (OWE transition)".into()
    } else {
        "Open".into()
    };
    sec
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rsn_ie(akms: &[u8], caps: u16) -> Vec<u8> {
        let mut v = vec![1, 0, 0x00, 0x0f, 0xac, 4, 1, 0, 0x00, 0x0f, 0xac, 4];
        v.extend_from_slice(&(akms.len() as u16).to_le_bytes());
        for a in akms {
            v.extend_from_slice(&[0x00, 0x0f, 0xac, *a]);
        }
        v.extend_from_slice(&caps.to_le_bytes());
        let mut ie = vec![48, v.len() as u8];
        ie.extend(v);
        ie
    }

    #[test]
    fn labels() {
        let cases: &[(&[u8], u16, &str, &str)] = &[
            (&[2], 0, "WPA2-Personal", "disabled"),
            (&[2, 8], 0x80, "WPA2/WPA3-Personal", "capable"),
            (&[8], 0xc0, "WPA3-Personal", "required"),
            (&[1], 0, "WPA2-Enterprise", "disabled"),
            (&[5], 0xc0, "WPA3-Enterprise", "required"),
            (&[18], 0xc0, "OWE", "required"),
            (&[12], 0xc0, "WPA3-Enterprise 192-bit", "required"),
        ];
        for (akms, caps, label, pmf) in cases {
            let ie = rsn_ie(akms, *caps);
            let els = Elements::parse(&ie);
            let s = classify(&els, Some(0x0011));
            assert_eq!(&s.label, label);
            assert_eq!(&s.pmf, pmf);
        }
        let els = Elements::parse(&[]);
        assert_eq!(classify(&els, Some(0x0001)).label, "Open");
        assert_eq!(classify(&els, Some(0x0011)).label, "WEP");
    }
}
