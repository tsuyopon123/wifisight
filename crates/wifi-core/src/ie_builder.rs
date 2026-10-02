//! Test helper: builds real 802.11 IE encodings for analysis tests.
#![allow(dead_code)] // builders for IEs not every test uses yet

#[derive(Default)]
pub struct IeBuilder {
    buf: Vec<u8>,
}

fn width_code_6g(w: u32) -> u8 {
    match w {
        20 => 0,
        40 => 1,
        80 => 2,
        _ => 3,
    }
}

impl IeBuilder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn build(self) -> Vec<u8> {
        self.buf
    }
    pub fn el(mut self, id: u8, data: &[u8]) -> Self {
        self.buf.push(id);
        self.buf.push(data.len() as u8);
        self.buf.extend_from_slice(data);
        self
    }
    pub fn ext(self, ext: u8, data: &[u8]) -> Self {
        let mut d = vec![ext];
        d.extend_from_slice(data);
        self.el(255, &d)
    }
    pub fn vendor(self, oui: [u8; 3], t: u8, data: &[u8]) -> Self {
        let mut d = oui.to_vec();
        d.push(t);
        d.extend_from_slice(data);
        self.el(221, &d)
    }
    pub fn ssid(self, s: &str) -> Self {
        self.el(0, s.as_bytes())
    }
    pub fn rates_24g(self) -> Self {
        self.el(1, &[0x82, 0x84, 0x8b, 0x96, 0x0c, 0x12, 0x18, 0x24])
            .el(50, &[0x30, 0x48, 0x60, 0x6c])
    }
    pub fn rates_5g(self) -> Self {
        self.el(1, &[0x8c, 0x12, 0x98, 0x24, 0xb0, 0x48, 0x60, 0x6c])
    }
    pub fn ds(self, ch: u8) -> Self {
        self.el(3, &[ch])
    }
    pub fn country(self, cc: &str) -> Self {
        let b = cc.as_bytes();
        self.el(7, &[b[0], b[1], 0x20, 36, 4, 23, 52, 4, 23, 100, 12, 30])
    }
    pub fn bss_load(self, sta: u16, util: u8) -> Self {
        let s = sta.to_le_bytes();
        self.el(11, &[s[0], s[1], util, 0, 0])
    }
    pub fn tpc(self, dbm: i8) -> Self {
        self.el(35, &[dbm as u8, 0])
    }
    pub fn ht_cap(self, nss: u8, w40: bool) -> Self {
        let mut info: u16 = 0x0020; // SGI20
        if w40 {
            info |= 0x0002 | 0x0040;
        }
        let mut d = vec![0u8; 26];
        d[..2].copy_from_slice(&info.to_le_bytes());
        d[2] = 0x17;
        for i in 0..nss.min(4) as usize {
            d[3 + i] = 0xff;
        }
        self.el(45, &d)
    }
    pub fn ht_op(self, primary: u8, sec_offset: u8) -> Self {
        let mut d = vec![0u8; 22];
        d[0] = primary;
        d[1] = sec_offset | if sec_offset != 0 { 0x04 } else { 0 };
        self.el(61, &d)
    }
    fn mcs_map(nss: u8, code: u16) -> u16 {
        let mut m: u16 = 0;
        for i in 0..8 {
            m |= (if i < nss { code } else { 3 }) << (i * 2);
        }
        m
    }
    pub fn vht_cap(self, nss: u8) -> Self {
        let info: u32 = (1 << 5) | (1 << 6) | (1 << 2); // 160 supported, SGI80/160
        let map = Self::mcs_map(nss, 2);
        let mut d = info.to_le_bytes().to_vec();
        d.extend_from_slice(&map.to_le_bytes());
        d.extend_from_slice(&[0, 0]);
        d.extend_from_slice(&map.to_le_bytes());
        d.extend_from_slice(&[0, 0]);
        self.el(191, &d)
    }
    pub fn vht_op(self, width: u8, c0: u8, c1: u8) -> Self {
        self.el(192, &[width, c0, c1, 0xfc, 0xff])
    }
    /// width_set bits: 0x01 40@2.4, 0x02 40/80@5/6, 0x04 160
    pub fn he_cap(self, nss: u8, width_set: u8) -> Self {
        let mut d = vec![0u8; 6 + 11];
        d[6] = width_set << 1;
        let map = Self::mcs_map(nss, 2).to_le_bytes();
        for _ in 0..if width_set & 0x04 != 0 { 2 } else { 1 } {
            d.extend_from_slice(&map);
            d.extend_from_slice(&map);
        }
        self.ext(35, &d)
    }
    /// six: (primary, width, ccfs0, ccfs1)
    pub fn he_op(self, color: u8, six: Option<(u8, u32, u8, u8)>) -> Self {
        let mut d = vec![
            0x04,
            0x00,
            if six.is_some() { 0x02 } else { 0x00 },
            color & 0x3f,
            0xfc,
            0xff,
        ];
        if let Some((p, w, c0, c1)) = six {
            d.extend_from_slice(&[p, width_code_6g(w), c0, c1, 0x06]);
        }
        self.ext(36, &d)
    }
    pub fn eht_cap(self, nss: u8, w320: bool) -> Self {
        let mut d = vec![0u8; 2 + 9];
        if w320 {
            d[2] |= 0x02;
        }
        let b = nss | (nss << 4);
        d.extend_from_slice(&[b, b, b]);
        d.extend_from_slice(&[b, b, b]);
        if w320 {
            d.extend_from_slice(&[b, b, b]);
        }
        self.ext(108, &d)
    }
    pub fn eht_op(self, width: u32, c0: u8, c1: u8) -> Self {
        let code = match width {
            20 => 0,
            40 => 1,
            80 => 2,
            160 => 3,
            _ => 4,
        };
        self.ext(106, &[0x01, 0x44, 0x44, 0x44, 0x44, code, c0, c1])
    }
    pub fn rsn(self, akms: &[u8], caps: u16) -> Self {
        let mut v = vec![1, 0, 0x00, 0x0f, 0xac, 4, 1, 0, 0x00, 0x0f, 0xac, 4];
        v.extend_from_slice(&(akms.len() as u16).to_le_bytes());
        for a in akms {
            v.extend_from_slice(&[0x00, 0x0f, 0xac, *a]);
        }
        v.extend_from_slice(&caps.to_le_bytes());
        if caps & 0x80 != 0 {
            v.extend_from_slice(&[0, 0, 0x00, 0x0f, 0xac, 6]);
        }
        self.el(48, &v)
    }
    pub fn rm_cap(self) -> Self {
        self.el(70, &[0x73, 0xd0, 0x00, 0x00, 0x0c])
    }
    pub fn mobility_domain(self, mdid: u16) -> Self {
        let m = mdid.to_le_bytes();
        self.el(54, &[m[0], m[1], 0x01])
    }
    pub fn ext_cap(self, bits: &[usize]) -> Self {
        let mut d = vec![0u8; 10];
        for &b in bits {
            d[b / 8] |= 1 << (b % 8);
        }
        self.el(127, &d)
    }
    pub fn wmm(self) -> Self {
        self.vendor([0x00, 0x50, 0xf2], 2, &[0x01, 0x01, 0x80, 0x00])
    }
    pub fn interworking(self, ant: u8, internet: bool) -> Self {
        self.el(107, &[ant | if internet { 0x10 } else { 0 }])
    }
    pub fn roaming_consortium(self, ois: &[&[u8]]) -> Self {
        let mut d = vec![0u8, 0u8];
        let l1 = ois.first().map(|o| o.len()).unwrap_or(0) as u8;
        let l2 = ois.get(1).map(|o| o.len()).unwrap_or(0) as u8;
        d[1] = l1 | (l2 << 4);
        for o in ois.iter().take(2) {
            d.extend_from_slice(o);
        }
        self.el(111, &d)
    }
    pub fn passpoint(self) -> Self {
        self.vendor([0x50, 0x6f, 0x9a], 0x10, &[0x10])
    }
    pub fn owe_transition(self, bssid: [u8; 6], ssid: &str) -> Self {
        let mut d = bssid.to_vec();
        d.push(ssid.len() as u8);
        d.extend_from_slice(ssid.as_bytes());
        self.vendor([0x50, 0x6f, 0x9a], 0x1c, &d)
    }
    pub fn cisco_name(self, name: &str) -> Self {
        let mut d = vec![0u8; 10];
        let mut n = name.as_bytes().to_vec();
        n.resize(16, 0);
        d.extend_from_slice(&n);
        d.extend_from_slice(&[0, 0, 0, 0]);
        self.el(133, &d)
    }
}
