//! Max PHY data-rate calculation for HT / VHT / HE / EHT.

/// Coded bits per subcarrier × coding rate, indexed by MCS 0..=13.
const BITS: [f64; 14] = [
    0.5,
    1.0,
    1.5,
    2.0,
    3.0,
    4.0,
    4.5,
    5.0,
    6.0,
    20.0 / 3.0,
    7.5,
    25.0 / 3.0,
    9.0,
    10.0,
];

fn nsd_ht_vht(width: u32) -> f64 {
    match width {
        20 => 52.0,
        40 => 108.0,
        80 => 234.0,
        _ => 468.0,
    }
}

fn nsd_he(width: u32) -> f64 {
    match width {
        20 => 234.0,
        40 => 468.0,
        80 => 980.0,
        160 => 1960.0,
        _ => 3920.0,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phy {
    Legacy,
    Ht,
    Vht,
    He,
    Eht,
}

/// Rate in Mbps.
pub fn rate(phy: Phy, width: u32, mcs: u8, nss: u8, short_gi: bool) -> f64 {
    let mcs = mcs.min(13) as usize;
    let nss = nss.max(1) as f64;
    match phy {
        Phy::Legacy => 0.0,
        Phy::Ht | Phy::Vht => {
            let sym = if short_gi { 3.6 } else { 4.0 };
            nsd_ht_vht(width) * BITS[mcs] * nss / sym
        }
        Phy::He | Phy::Eht => {
            // 12.8 µs symbol + 0.8 µs GI
            nsd_he(width) * BITS[mcs] * nss / 13.6
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 0.6, "{a} vs {b}");
    }
    #[test]
    fn known_rates() {
        approx(rate(Phy::Ht, 40, 7, 1, true), 150.0);
        approx(rate(Phy::Ht, 20, 7, 2, true), 144.4);
        approx(rate(Phy::Vht, 80, 9, 1, true), 433.3);
        approx(rate(Phy::Vht, 80, 9, 4, true), 1733.3);
        approx(rate(Phy::He, 80, 11, 2, true), 1201.0);
        approx(rate(Phy::He, 160, 11, 4, true), 4803.9);
        approx(rate(Phy::Eht, 320, 13, 2, true), 5764.7);
    }
}
