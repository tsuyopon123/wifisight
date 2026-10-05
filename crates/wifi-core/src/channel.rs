use crate::model::Band;

pub fn band_of(freq_mhz: u32) -> Band {
    match freq_mhz {
        2400..=2500 => Band::B2g4,
        4900..=5899 => Band::B5,
        5925..=7125 => Band::B6,
        _ => Band::Other,
    }
}

pub fn freq_to_channel(freq_mhz: u32) -> Option<u32> {
    match band_of(freq_mhz) {
        Band::B2g4 => {
            if freq_mhz == 2484 {
                Some(14)
            } else if freq_mhz >= 2412 {
                Some((freq_mhz - 2407) / 5)
            } else {
                None
            }
        }
        // Japan's 4.9 GHz band (ch 182–196) counts from 4000 MHz
        Band::B5 if freq_mhz < 5000 => Some((freq_mhz - 4000) / 5),
        Band::B5 => Some((freq_mhz - 5000) / 5),
        Band::B6 => {
            if freq_mhz == 5935 {
                Some(2)
            } else if freq_mhz >= 5955 {
                Some((freq_mhz - 5950) / 5)
            } else {
                None
            }
        }
        Band::Other => None,
    }
}

pub fn channel_to_freq(band: Band, ch: u32) -> Option<u32> {
    match band {
        Band::B2g4 => match ch {
            14 => Some(2484),
            1..=13 => Some(2407 + ch * 5),
            _ => None,
        },
        Band::B5 if ch >= 182 => Some(4000 + ch * 5), // 4.9 GHz; 5 GHz channels end at 177
        Band::B5 => Some(5000 + ch * 5),
        Band::B6 => {
            if ch == 2 {
                Some(5935)
            } else {
                Some(5950 + ch * 5)
            }
        }
        Band::Other => None,
    }
}

/// Primary channel → band from what the OS reports (used when frequency is missing).
pub fn band_label(b: Band) -> &'static str {
    match b {
        Band::B2g4 => "2.4 GHz",
        Band::B5 => "5 GHz",
        Band::B6 => "6 GHz",
        Band::Other => "other",
    }
}

/// DFS channels in 5 GHz (W53 / W56 in Japan).
pub fn is_dfs_5g(ch: u32) -> bool {
    (52..=144).contains(&ch)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conversions() {
        assert_eq!(freq_to_channel(2412), Some(1));
        assert_eq!(freq_to_channel(2484), Some(14));
        assert_eq!(freq_to_channel(5180), Some(36));
        assert_eq!(freq_to_channel(5825), Some(165));
        assert_eq!(freq_to_channel(5955), Some(1));
        assert_eq!(freq_to_channel(6115), Some(33));
        assert_eq!(channel_to_freq(Band::B6, 37), Some(6135));
        assert_eq!(channel_to_freq(Band::B5, 42), Some(5210));
        assert_eq!(freq_to_channel(4920), Some(184));
        assert_eq!(channel_to_freq(Band::B5, 184), Some(4920));
    }
}
