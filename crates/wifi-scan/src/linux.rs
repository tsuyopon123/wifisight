//! Linux backend: nl80211 over generic netlink, implemented directly on libc
//! sockets (no external netlink crate).

use crate::{Interface, ScanError, ScanOptions, ScanOutput};
use std::collections::HashMap;
use std::io;
use std::time::{Duration, Instant};
use wifi_core::RawBss;

// netlink / genetlink constants
const NETLINK_GENERIC: i32 = 16;
const NLM_F_REQUEST: u16 = 0x1;
const NLM_F_ACK: u16 = 0x4;
const NLM_F_DUMP: u16 = 0x300;
const NLMSG_ERROR: u16 = 2;
const NLMSG_DONE: u16 = 3;
const GENL_ID_CTRL: u16 = 0x10;
const CTRL_CMD_GETFAMILY: u8 = 3;
const CTRL_ATTR_FAMILY_ID: u16 = 1;
const CTRL_ATTR_FAMILY_NAME: u16 = 2;
const CTRL_ATTR_MCAST_GROUPS: u16 = 7;
const CTRL_ATTR_MCAST_GRP_NAME: u16 = 1;
const CTRL_ATTR_MCAST_GRP_ID: u16 = 2;
const SOL_NETLINK: i32 = 270;
const NETLINK_ADD_MEMBERSHIP: i32 = 1;

// nl80211
const NL80211_CMD_GET_INTERFACE: u8 = 5;
const NL80211_CMD_GET_SCAN: u8 = 32;
const NL80211_CMD_TRIGGER_SCAN: u8 = 33;
const NL80211_CMD_NEW_SCAN_RESULTS: u8 = 34;
const NL80211_CMD_SCAN_ABORTED: u8 = 35;
const NL80211_CMD_GET_SURVEY: u8 = 50;
const NL80211_ATTR_IFINDEX: u16 = 3;
const NL80211_ATTR_IFNAME: u16 = 4;
const NL80211_ATTR_IFTYPE: u16 = 5;
const NL80211_ATTR_MAC: u16 = 6;
const NL80211_ATTR_BSS: u16 = 47;
const NL80211_ATTR_SURVEY_INFO: u16 = 84;
const NL80211_IFTYPE_STATION: u32 = 2;
const NL80211_BSS_BSSID: u16 = 1;
const NL80211_BSS_FREQUENCY: u16 = 2;
const NL80211_BSS_BEACON_INTERVAL: u16 = 4;
const NL80211_BSS_CAPABILITY: u16 = 5;
const NL80211_BSS_INFORMATION_ELEMENTS: u16 = 6;
const NL80211_BSS_SIGNAL_MBM: u16 = 7;
const NL80211_BSS_SIGNAL_UNSPEC: u16 = 8;
const NL80211_BSS_STATUS: u16 = 9;
const NL80211_BSS_SEEN_MS_AGO: u16 = 10;
const NL80211_BSS_BEACON_IES: u16 = 11;
const NL80211_SURVEY_INFO_FREQUENCY: u16 = 1;
const NL80211_SURVEY_INFO_NOISE: u16 = 2;

/// (ifindex, ifname, iftype, MAC) from NL80211_CMD_GET_INTERFACE.
type IfaceInfo = (u32, String, u32, Option<[u8; 6]>);

struct Sock {
    fd: i32,
    seq: u32,
}

impl Drop for Sock {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

fn align4(n: usize) -> usize {
    (n + 3) & !3
}

fn put_attr(buf: &mut Vec<u8>, ty: u16, data: &[u8]) {
    let len = 4 + data.len();
    buf.extend_from_slice(&(len as u16).to_ne_bytes());
    buf.extend_from_slice(&ty.to_ne_bytes());
    buf.extend_from_slice(data);
    buf.resize(align4(buf.len()), 0);
}

fn attrs(mut d: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    while d.len() >= 4 {
        let len = u16::from_ne_bytes([d[0], d[1]]) as usize;
        let ty = u16::from_ne_bytes([d[2], d[3]]) & 0x3fff;
        if len < 4 || len > d.len() {
            break;
        }
        out.push((ty, &d[4..len]));
        let adv = align4(len).min(d.len());
        d = &d[adv..];
    }
    out
}

fn get<'a>(a: &[(u16, &'a [u8])], ty: u16) -> Option<&'a [u8]> {
    a.iter().find(|(t, _)| *t == ty).map(|(_, d)| *d)
}

fn u32_of(d: &[u8]) -> Option<u32> {
    d.get(..4)
        .map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
}

fn u16_of(d: &[u8]) -> Option<u16> {
    d.get(..2).map(|b| u16::from_ne_bytes([b[0], b[1]]))
}

impl Sock {
    fn open() -> io::Result<Sock> {
        unsafe {
            let fd = libc::socket(
                libc::AF_NETLINK,
                libc::SOCK_RAW | libc::SOCK_CLOEXEC,
                NETLINK_GENERIC,
            );
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let mut addr: libc::sockaddr_nl = std::mem::zeroed();
            addr.nl_family = libc::AF_NETLINK as u16;
            if libc::bind(
                fd,
                &addr as *const _ as *const libc::sockaddr,
                std::mem::size_of::<libc::sockaddr_nl>() as u32,
            ) < 0
            {
                let e = io::Error::last_os_error();
                libc::close(fd);
                return Err(e);
            }
            Ok(Sock { fd, seq: 1 })
        }
    }

    fn set_timeout(&self, d: Duration) {
        let tv = libc::timeval {
            tv_sec: d.as_secs() as _,
            tv_usec: d.subsec_micros() as _,
        };
        unsafe {
            libc::setsockopt(
                self.fd,
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                &tv as *const _ as *const libc::c_void,
                std::mem::size_of::<libc::timeval>() as u32,
            );
        }
    }

    fn join_group(&self, group: u32) -> io::Result<()> {
        let r = unsafe {
            libc::setsockopt(
                self.fd,
                SOL_NETLINK,
                NETLINK_ADD_MEMBERSHIP,
                &group as *const _ as *const libc::c_void,
                4,
            )
        };
        if r < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn send(&mut self, family: u16, flags: u16, cmd: u8, attr_buf: &[u8]) -> io::Result<u32> {
        self.seq += 1;
        let seq = self.seq;
        let len = 16 + 4 + attr_buf.len();
        let mut msg = Vec::with_capacity(len);
        msg.extend_from_slice(&(len as u32).to_ne_bytes());
        msg.extend_from_slice(&family.to_ne_bytes());
        msg.extend_from_slice(&(flags | NLM_F_REQUEST).to_ne_bytes());
        msg.extend_from_slice(&seq.to_ne_bytes());
        msg.extend_from_slice(&0u32.to_ne_bytes());
        msg.extend_from_slice(&[cmd, 1, 0, 0]);
        msg.extend_from_slice(attr_buf);
        let r = unsafe { libc::send(self.fd, msg.as_ptr() as *const libc::c_void, msg.len(), 0) };
        if r < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(seq)
    }

    fn recv_raw(&self, buf: &mut [u8]) -> io::Result<usize> {
        let r = unsafe { libc::recv(self.fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
        if r < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(r as usize)
        }
    }

    /// Send a request and collect (cmd, attrs payload) of all replies.
    fn request(
        &mut self,
        family: u16,
        cmd: u8,
        dump: bool,
        attr_buf: &[u8],
    ) -> io::Result<Vec<(u8, Vec<u8>)>> {
        let flags = if dump { NLM_F_DUMP } else { NLM_F_ACK };
        let seq = self.send(family, flags, cmd, attr_buf)?;
        let mut out = Vec::new();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = self.recv_raw(&mut buf)?;
            let mut d = &buf[..n];
            while d.len() >= 16 {
                let len = u32::from_ne_bytes([d[0], d[1], d[2], d[3]]) as usize;
                let ty = u16::from_ne_bytes([d[4], d[5]]);
                let mseq = u32::from_ne_bytes([d[8], d[9], d[10], d[11]]);
                if len < 16 || len > d.len() {
                    break;
                }
                let payload = &d[16..len];
                d = &d[align4(len).min(d.len())..];
                if mseq != seq {
                    continue;
                }
                match ty {
                    NLMSG_DONE => return Ok(out),
                    NLMSG_ERROR => {
                        let err = payload
                            .get(..4)
                            .map(|b| i32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
                            .unwrap_or(0);
                        if err == 0 {
                            return Ok(out);
                        }
                        return Err(io::Error::from_raw_os_error(-err));
                    }
                    _ => {
                        if payload.len() >= 4 {
                            out.push((payload[0], payload[4..].to_vec()));
                        }
                    }
                }
            }
        }
    }
}

struct Nl80211 {
    sock: Sock,
    family: u16,
    scan_group: Option<u32>,
}

impl Nl80211 {
    fn open() -> Result<Self, ScanError> {
        let mut sock = Sock::open().map_err(|e| ScanError::Os(format!("netlink socket: {e}")))?;
        sock.set_timeout(Duration::from_secs(5));
        let mut a = Vec::new();
        put_attr(&mut a, CTRL_ATTR_FAMILY_NAME, b"nl80211\0");
        let replies = sock
            .request(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, false, &a)
            .map_err(|e| {
                ScanError::Os(format!("nl80211 not available (is cfg80211 loaded?): {e}"))
            })?;
        let (_, payload) = replies
            .first()
            .ok_or_else(|| ScanError::Os("nl80211 family not found".into()))?;
        let at = attrs(payload);
        let family = get(&at, CTRL_ATTR_FAMILY_ID)
            .and_then(u16_of)
            .ok_or_else(|| ScanError::Os("nl80211 family id missing".into()))?;
        let mut scan_group = None;
        if let Some(groups) = get(&at, CTRL_ATTR_MCAST_GROUPS) {
            for (_, g) in attrs(groups) {
                let ga = attrs(g);
                let name = get(&ga, CTRL_ATTR_MCAST_GRP_NAME).unwrap_or(&[]);
                if name.starts_with(b"scan") {
                    scan_group = get(&ga, CTRL_ATTR_MCAST_GRP_ID).and_then(u32_of);
                }
            }
        }
        Ok(Nl80211 {
            sock,
            family,
            scan_group,
        })
    }

    fn interfaces(&mut self) -> Result<Vec<IfaceInfo>, ScanError> {
        let replies = self
            .sock
            .request(self.family, NL80211_CMD_GET_INTERFACE, true, &[])
            .map_err(|e| ScanError::Os(format!("GET_INTERFACE: {e}")))?;
        let mut out = Vec::new();
        for (_, p) in replies {
            let a = attrs(&p);
            let (Some(idx), Some(name)) = (
                get(&a, NL80211_ATTR_IFINDEX).and_then(u32_of),
                get(&a, NL80211_ATTR_IFNAME),
            ) else {
                continue;
            };
            let name = String::from_utf8_lossy(name)
                .trim_end_matches('\0')
                .to_string();
            let ty = get(&a, NL80211_ATTR_IFTYPE).and_then(u32_of).unwrap_or(0);
            let mac = get(&a, NL80211_ATTR_MAC)
                .filter(|m| m.len() >= 6)
                .map(|m| [m[0], m[1], m[2], m[3], m[4], m[5]]);
            out.push((idx, name, ty, mac));
        }
        Ok(out)
    }

    fn ifindex_attr(ifindex: u32) -> Vec<u8> {
        let mut a = Vec::new();
        put_attr(&mut a, NL80211_ATTR_IFINDEX, &ifindex.to_ne_bytes());
        a
    }

    fn trigger(&mut self, ifindex: u32) -> io::Result<()> {
        self.sock
            .request(
                self.family,
                NL80211_CMD_TRIGGER_SCAN,
                false,
                &Self::ifindex_attr(ifindex),
            )
            .map(|_| ())
    }

    fn survey(&mut self, ifindex: u32) -> HashMap<u32, i32> {
        let mut m = HashMap::new();
        if let Ok(replies) = self.sock.request(
            self.family,
            NL80211_CMD_GET_SURVEY,
            true,
            &Self::ifindex_attr(ifindex),
        ) {
            for (_, p) in replies {
                let a = attrs(&p);
                if let Some(info) = get(&a, NL80211_ATTR_SURVEY_INFO) {
                    let i = attrs(info);
                    if let (Some(f), Some(n)) = (
                        get(&i, NL80211_SURVEY_INFO_FREQUENCY).and_then(u32_of),
                        get(&i, NL80211_SURVEY_INFO_NOISE),
                    ) {
                        if let Some(&b) = n.first() {
                            m.insert(f, b as i8 as i32);
                        }
                    }
                }
            }
        }
        m
    }

    fn dump(&mut self, ifindex: u32) -> Result<Vec<RawBss>, ScanError> {
        let replies = self
            .sock
            .request(
                self.family,
                NL80211_CMD_GET_SCAN,
                true,
                &Self::ifindex_attr(ifindex),
            )
            .map_err(|e| ScanError::Os(format!("GET_SCAN: {e}")))?;
        let noise = self.survey(ifindex);
        let mut out = Vec::new();
        for (_, p) in replies {
            let a = attrs(&p);
            let Some(bss) = get(&a, NL80211_ATTR_BSS) else {
                continue;
            };
            let b = attrs(bss);
            let Some(mac) = get(&b, NL80211_BSS_BSSID).filter(|m| m.len() >= 6) else {
                continue;
            };
            let freq = get(&b, NL80211_BSS_FREQUENCY).and_then(u32_of).unwrap_or(0);
            let rssi = if let Some(mbm) = get(&b, NL80211_BSS_SIGNAL_MBM).and_then(u32_of) {
                (mbm as i32) / 100
            } else if let Some(u) = get(&b, NL80211_BSS_SIGNAL_UNSPEC).and_then(|d| d.first()) {
                // 0..100 quality → rough dBm
                *u as i32 / 2 - 100
            } else {
                -100
            };
            let ies = get(&b, NL80211_BSS_INFORMATION_ELEMENTS)
                .filter(|d| !d.is_empty())
                .or_else(|| get(&b, NL80211_BSS_BEACON_IES))
                .unwrap_or(&[])
                .to_vec();
            out.push(RawBss {
                bssid: [mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]],
                ssid: None,
                freq_mhz: freq,
                rssi_dbm: rssi,
                noise_dbm: noise.get(&freq).copied(),
                beacon_interval_tu: get(&b, NL80211_BSS_BEACON_INTERVAL).and_then(u16_of),
                capability: get(&b, NL80211_BSS_CAPABILITY).and_then(u16_of),
                ies,
                age_ms: get(&b, NL80211_BSS_SEEN_MS_AGO).and_then(u32_of),
                connected: get(&b, NL80211_BSS_STATUS).and_then(u32_of) == Some(1),
                os_channel_width_mhz: None,
                os_country: None,
            });
        }
        Ok(out)
    }
}

/// Wait for NEW_SCAN_RESULTS / SCAN_ABORTED for `ifindex` on the scan multicast group.
fn wait_scan_done(ev: &Sock, ifindex: u32, timeout: Duration) -> bool {
    let start = Instant::now();
    let mut buf = vec![0u8; 64 * 1024];
    ev.set_timeout(Duration::from_millis(500));
    while start.elapsed() < timeout {
        let Ok(n) = ev.recv_raw(&mut buf) else {
            continue;
        };
        let mut d = &buf[..n];
        while d.len() >= 20 {
            let len = u32::from_ne_bytes([d[0], d[1], d[2], d[3]]) as usize;
            if len < 20 || len > d.len() {
                break;
            }
            let cmd = d[16];
            let a = attrs(&d[20..len]);
            let idx = get(&a, NL80211_ATTR_IFINDEX).and_then(u32_of);
            if (cmd == NL80211_CMD_NEW_SCAN_RESULTS || cmd == NL80211_CMD_SCAN_ABORTED)
                && idx == Some(ifindex)
            {
                return true;
            }
            d = &d[align4(len).min(d.len())..];
        }
    }
    false
}

pub fn interfaces() -> Result<Vec<Interface>, ScanError> {
    let mut nl = Nl80211::open()?;
    Ok(nl
        .interfaces()?
        .into_iter()
        .map(|(idx, name, ty, mac)| Interface {
            id: name.clone(),
            description: format!(
                "ifindex {idx}{}",
                if ty == NL80211_IFTYPE_STATION {
                    ", station"
                } else {
                    ""
                }
            ),
            name,
            mac: mac.map(|m| wifi_core::fmt_mac(&m)),
        })
        .collect())
}

pub fn scan(opts: &ScanOptions) -> Result<ScanOutput, ScanError> {
    let mut nl = Nl80211::open()?;
    let ifs = nl.interfaces()?;
    let chosen = match &opts.interface {
        Some(name) => ifs.iter().find(|i| &i.1 == name),
        None => ifs
            .iter()
            .find(|i| i.2 == NL80211_IFTYPE_STATION)
            .or(ifs.first()),
    }
    .cloned()
    .ok_or(ScanError::NoInterface)?;
    let (ifindex, ifname, _, _) = chosen;
    let mut warnings = Vec::new();

    if opts.trigger {
        // Subscribe before triggering so we don't miss the completion event.
        let ev = nl.scan_group.and_then(|g| {
            let s = Sock::open().ok()?;
            s.join_group(g).ok()?;
            Some(s)
        });
        let mut triggered = true;
        match nl.trigger(ifindex) {
            Ok(()) => {}
            Err(e) if e.raw_os_error() == Some(libc::EBUSY) => {}
            Err(e) if matches!(e.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES)) => {
                // Unprivileged: ask NetworkManager (polkit allows this for local users)
                let ok = std::process::Command::new("nmcli")
                    .args(["device", "wifi", "rescan", "ifname", &ifname])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if !ok {
                    triggered = false;
                    warnings.push(
                        "Scan trigger needs CAP_NET_ADMIN (run with sudo or `setcap cap_net_admin+ep`); showing cached results".into(),
                    );
                }
            }
            Err(e) => {
                triggered = false;
                warnings.push(format!("TRIGGER_SCAN failed: {e}"));
            }
        }
        if triggered && opts.wait {
            if let Some(ev) = &ev {
                if !wait_scan_done(ev, ifindex, Duration::from_secs(10)) {
                    warnings.push("scan did not complete within 10 s".into());
                }
            } else {
                std::thread::sleep(Duration::from_secs(4));
            }
        }
    }
    let bss = nl.dump(ifindex)?;
    Ok(ScanOutput {
        interface: ifname,
        bss,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attr_roundtrip() {
        let mut b = Vec::new();
        put_attr(&mut b, 3, &7u32.to_ne_bytes());
        put_attr(&mut b, 4, b"wlan0\0");
        let a = attrs(&b);
        assert_eq!(a.len(), 2);
        assert_eq!(u32_of(get(&a, 3).unwrap()), Some(7));
        assert_eq!(get(&a, 4).unwrap(), b"wlan0\0");
    }
}
