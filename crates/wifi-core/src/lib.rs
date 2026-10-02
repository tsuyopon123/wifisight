//! wifi-core: platform-independent analysis of 802.11 scan results.
//!
//! Platform scanners (CoreWLAN / WLAN API / nl80211) only need to produce a
//! [`RawBss`] (BSSID, frequency, RSSI and the raw Information Elements).
//! Everything shown in the UI — channel width, PHY generation, security,
//! max PHY rate, BSS load, 11k/v/r, Passpoint … — is derived here so every OS
//! renders identical results.

pub mod analyze;
pub mod channel;
pub mod ie;
#[cfg(test)]
mod ie_builder;
pub mod model;
pub mod oui;
pub mod rates;
pub mod security;

pub use analyze::analyze;
pub use model::*;
pub use oui::OuiDb;
