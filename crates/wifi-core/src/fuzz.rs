//! Randomised robustness test: IEs arrive over the air, so no byte sequence may make `analyze()` panic.
//! Deterministic (fixed seed) so a failure reproduces; runs on stable with `cargo test`.

use crate::ie::*;
use crate::ie_builder::IeBuilder;
use crate::{analyze, RawBss};

/// xorshift64*: enough randomness for input generation, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn byte(&mut self) -> u8 {
        self.next() as u8
    }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len())]
    }
}

const IDS: &[u8] = &[
    EID_SSID,
    EID_SUPP_RATES,
    EID_DS_PARAMS,
    EID_TIM,
    EID_COUNTRY,
    EID_BSS_LOAD,
    EID_POWER_CONSTRAINT,
    EID_TPC_REPORT,
    EID_HT_CAP,
    EID_RSN,
    EID_EXT_SUPP_RATES,
    EID_MOBILITY_DOMAIN,
    EID_HT_OP,
    EID_RM_ENABLED_CAP,
    EID_MULTIPLE_BSSID,
    EID_INTERWORKING,
    EID_ADV_PROTOCOL,
    EID_ROAMING_CONSORTIUM,
    EID_EXT_CAP,
    EID_CISCO_CCX1,
    EID_VHT_CAP,
    EID_VHT_OP,
    EID_TPE,
    EID_RNR,
    EID_VENDOR,
    EID_EXTENSION,
];
const EXTS: &[u8] = &[
    EXT_HE_CAP,
    EXT_HE_OP,
    EXT_MU_EDCA,
    EXT_SPATIAL_REUSE,
    EXT_HE_6G_CAP,
    EXT_EHT_OP,
    EXT_MULTI_LINK,
    EXT_EHT_CAP,
];
// OUIs the parser looks into: Microsoft (WMM/WPS), WFA, IEEE, and the AP-name vendors
const OUIS: &[[u8; 3]] = &[
    OUI_MICROSOFT,
    OUI_WFA,
    OUI_IEEE,
    [0x00, 0x40, 0x96],
    [0x00, 0x15, 0x6d],
    [0x5c, 0x5b, 0x35],
    [0x00, 0x13, 0x92],
    [0x00, 0x11, 0x74],
    [0xdc, 0x08, 0x56],
    [0x84, 0x80, 0x94],
    [0x48, 0xd0, 0x17],
    [0x3c, 0xb9, 0xa6],
    [0x00, 0x0b, 0x86],
    [0x00, 0xe0, 0xfc],
    [0x00, 0x19, 0x77],
    [0x00, 0xa0, 0xf8],
    [0x00, 0x09, 0x0f],
];
const FREQS: &[u32] = &[
    0, 2412, 2437, 2484, 4920, 4980, 5180, 5500, 5745, 5825, 5955, 6115, 7115, 60480,
];

/// One element with a random (often degenerate) length, biased toward IDs and sub-types the parser decodes.
fn element(r: &mut Rng, out: &mut Vec<u8>) {
    let id = if r.below(8) == 0 {
        r.byte()
    } else {
        r.pick(IDS)
    };
    let len = match r.below(6) {
        0 => 0,
        1 => 1,
        2 => r.below(4) + 2,
        3 => 255,
        _ => r.below(64),
    };
    let mut body: Vec<u8> = (0..len).map(|_| r.byte()).collect();
    // give extension / vendor elements a meaningful head so the deeper parsers run
    if id == EID_EXTENSION && !body.is_empty() {
        body[0] = r.pick(EXTS);
    }
    if id == EID_VENDOR && body.len() >= 4 {
        body[..3].copy_from_slice(&r.pick(OUIS));
        body[3] = r.below(48) as u8;
    }
    out.push(id);
    out.push(len as u8);
    out.extend_from_slice(&body);
}

/// Valid beacons from the test builder, to be mutated.
fn seeds() -> Vec<Vec<u8>> {
    vec![
        IeBuilder::new()
            .ssid("hall")
            .rates_24g()
            .ds(6)
            .country("JP")
            .bss_load(12, 80)
            .ht_cap(2, true)
            .ht_op(6, 1)
            .build(),
        IeBuilder::new()
            .ssid("x")
            .rates_5g()
            .ht_cap(4, true)
            .ht_op(36, 1)
            .vht_cap(4)
            .vht_op(1, 42, 0)
            .he_cap(4, 0b110)
            .he_op(7, None)
            .build(),
        IeBuilder::new()
            .ssid("six")
            .he_cap(2, 0b110)
            .he_op(3, Some((37, 2, 39, 0)))
            .eht_cap(2, true)
            .eht_op(320, 31, 63)
            .build(),
        IeBuilder::new()
            .ssid("sec")
            .rsn(&[8, 24], 0xc0)
            .rm_cap()
            .mobility_domain(0x1234)
            .ext_cap(&[19, 31, 63])
            .wmm()
            .build(),
        IeBuilder::new()
            .ssid("hs20")
            .interworking(2, true)
            .roaming_consortium(&[&[0x5a, 0x03, 0xba], &[0x00, 0x1b, 0xc5, 0x04, 0x60]])
            .passpoint()
            .build(),
        IeBuilder::new()
            .ssid("")
            .owe_transition([2, 0, 0, 0, 0, 1], "owe")
            .cisco_name("AP-1")
            .tpc(17)
            .build(),
    ]
}

fn mutate(r: &mut Rng, mut b: Vec<u8>) -> Vec<u8> {
    for _ in 0..r.below(4) + 1 {
        if b.is_empty() {
            break;
        }
        match r.below(4) {
            0 => {
                let i = r.below(b.len());
                b[i] ^= 1 << r.below(8);
            }
            1 => {
                let i = r.below(b.len());
                b[i] = r.byte();
            }
            2 => b.truncate(r.below(b.len())),
            _ => {
                let i = r.below(b.len());
                b.insert(i, r.byte());
            }
        }
    }
    b
}

#[test]
fn analyze_never_panics() {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let seeds = seeds();
    for _ in 0..30_000 {
        let ies = if r.below(2) == 0 {
            let mut v = Vec::new();
            for _ in 0..r.below(12) {
                element(&mut r, &mut v);
            }
            if r.below(4) == 0 && !v.is_empty() {
                let n = r.below(v.len());
                v.truncate(n); // cut the last element short
            }
            v
        } else {
            let seed = seeds[r.below(seeds.len())].clone();
            mutate(&mut r, seed)
        };
        let raw = RawBss {
            bssid: [r.byte(), r.byte(), r.byte(), r.byte(), r.byte(), r.byte()],
            ssid: if r.below(3) == 0 {
                Some((0..r.below(40)).map(|_| r.byte()).collect())
            } else {
                None
            },
            freq_mhz: if r.below(8) == 0 {
                r.below(8000) as u32
            } else {
                r.pick(FREQS)
            },
            rssi_dbm: -(r.below(110) as i32),
            noise_dbm: if r.below(2) == 0 { Some(-95) } else { None },
            os_channel_width_mhz: if r.below(2) == 0 {
                Some(r.pick(&[0, 20, 40, 80, 160, 320, 7]))
            } else {
                None
            },
            ies,
            ..Default::default()
        };
        let input = crate::hex(&raw.ies[..raw.ies.len().min(96)]);
        let res = std::panic::catch_unwind(|| analyze(&raw, None));
        assert!(
            res.is_ok(),
            "analyze panicked: freq {} width {:?} ies (first 96 B) {input}",
            raw.freq_mhz,
            raw.os_channel_width_mhz
        );
    }
}

#[test]
fn unknown_frequency() {
    // found by the test above: no frequency from the OS + a width underflowed the occupied range
    let raw = RawBss {
        os_channel_width_mhz: Some(80),
        ..Default::default()
    };
    let b = analyze(&raw, None);
    assert_eq!((b.freq_low_mhz, b.freq_high_mhz), (0, 0));
}
