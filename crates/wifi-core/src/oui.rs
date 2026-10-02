//! IEEE OUI (MA-L) vendor lookup.
//!
//! The full registry is ~4 MB, so it is not embedded. Load it from the IEEE CSV
//! (`https://standards-oui.ieee.org/oui/oui.csv`). The GUI can download it.

use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub struct OuiDb {
    map: HashMap<u32, String>,
}

impl OuiDb {
    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Parse IEEE `oui.csv` (columns: Registry,Assignment,Organization Name,Organization Address).
    pub fn from_ieee_csv(text: &str) -> Self {
        let mut map = HashMap::new();
        for line in text.lines().skip(1) {
            let cols = split_csv(line);
            if cols.len() < 3 {
                continue;
            }
            if let Ok(v) = u32::from_str_radix(cols[1].trim(), 16) {
                map.insert(v, cols[2].trim().to_string());
            }
        }
        OuiDb { map }
    }

    pub fn lookup(&self, mac: &[u8; 6]) -> Option<&str> {
        let key = ((mac[0] as u32) << 16) | ((mac[1] as u32) << 8) | mac[2] as u32;
        self.map.get(&key).map(|s| s.as_str())
    }
}

/// Locally administered bit (U/L bit). Many enterprise APs use these for extra BSSIDs.
pub fn is_locally_administered(mac: &[u8; 6]) -> bool {
    mac[0] & 0x02 != 0
}

fn split_csv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut q = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if q && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => q = !q,
            ',' if !q => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv() {
        let t = "Registry,Assignment,Organization Name,Organization Address\nMA-L,00000C,\"Cisco Systems, Inc\",170 West Tasman\n";
        let db = OuiDb::from_ieee_csv(t);
        assert_eq!(
            db.lookup(&[0, 0, 0x0c, 1, 2, 3]),
            Some("Cisco Systems, Inc")
        );
        assert!(is_locally_administered(&[0x02, 0, 0, 0, 0, 0]));
    }
}
