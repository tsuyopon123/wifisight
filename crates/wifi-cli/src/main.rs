//! wifisight-cli — headless scanner/logger sharing the GUI's analysis engine.

use clap::{Parser, Subcommand, ValueEnum};
use serde::Serialize;
use std::io::Write;
use std::time::{Duration, Instant};
use wifi_core::{BssInfo, OuiDb, Snapshot};
use wifi_scan::ScanOptions;

#[derive(Parser)]
#[command(
    name = "wifisight-cli",
    version,
    about = "Wi-Fi scanner / survey logger (macOS / Windows / Linux)"
)]
struct Cli {
    /// IEEE oui.csv for vendor names (https://standards-oui.ieee.org/oui/oui.csv)
    #[arg(long, global = true)]
    oui: Option<std::path::PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List Wi-Fi interfaces
    Interfaces,
    /// One scan, printed as a table or JSON
    Scan {
        #[arg(short, long)]
        iface: Option<String>,
        /// Read cached results only (do not trigger a scan)
        #[arg(long)]
        no_trigger: bool,
        /// Full JSON (analysed BSS incl. decoded IEs)
        #[arg(long)]
        json: bool,
        /// Raw scanner output (hex IEs) as JSON — useful for bug reports / tests
        #[arg(long)]
        raw: bool,
        /// Sort order
        #[arg(long, value_enum, ignore_case = true, default_value_t = Sort::Rssi)]
        sort: Sort,
    },
    /// Scan repeatedly and append JSON Lines (one scan per line)
    Watch {
        #[arg(short, long)]
        iface: Option<String>,
        /// Seconds between scans
        #[arg(long, default_value_t = 5.0)]
        interval: f64,
        /// Output file (JSONL). Defaults to stdout.
        #[arg(short, long)]
        out: Option<std::path::PathBuf>,
        /// Include decoded IEs in every record (large)
        #[arg(long)]
        full: bool,
        /// Stop after N scans (0 = forever)
        #[arg(long, default_value_t = 0)]
        count: u64,
    },
    /// Current link (BSSID, TX/RX rate, MCS, NSS) as one JSON line; `null` when not connected
    Link {
        #[arg(short, long)]
        iface: Option<String>,
    },
    /// Run as an external probe: serve scans over HTTP (GET /, /interfaces, /scan?iface=X raw,
    /// /bss?iface=X analysed, /link?iface=X, /ui browser page)
    Serve {
        /// Address to listen on (e.g. one interface's IP: 192.168.1.20:8737)
        #[arg(long, default_value = "0.0.0.0:8737")]
        listen: String,
        /// Default interface when the request has no ?iface=
        #[arg(short, long)]
        iface: Option<String>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Sort {
    Rssi,
    Channel,
    Ssid,
}

fn sort(list: &mut [BssInfo], by: Sort) {
    match by {
        Sort::Rssi => list.sort_by_key(|b| -b.rssi_dbm),
        Sort::Channel => list.sort_by_key(|b| (b.freq_mhz, -b.rssi_dbm)),
        Sort::Ssid => list.sort_by(|a, b| a.ssid.cmp(&b.ssid).then(b.rssi_dbm.cmp(&a.rssi_dbm))),
    }
}

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Compact<'a> {
    bssid: &'a str,
    ssid: &'a str,
    ch: u32,
    center: u32,
    width: u32,
    band: wifi_core::Band,
    rssi: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    noise: Option<i32>,
    sec: &'a str,
    phy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sta: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    util: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ap: Option<&'a str>,
}

fn compact(b: &BssInfo) -> Compact<'_> {
    Compact {
        bssid: &b.bssid,
        ssid: &b.ssid,
        ch: b.channel,
        center: b.center_channel,
        width: b.width_mhz,
        band: b.band,
        rssi: b.rssi_dbm,
        noise: b.noise_dbm,
        sec: &b.security.label,
        phy: b.phy_modes.join("/"),
        sta: b.bss_load.as_ref().map(|l| l.station_count),
        util: b.bss_load.as_ref().map(|l| l.channel_utilization_pct),
        ap: b.ap_name.as_deref(),
    }
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n - 1).collect::<String>() + "…"
    }
}

fn print_table(list: &[BssInfo]) {
    println!(
        "{:<24} {:<17} {:>4} {:>4} {:>4} {:>5} {:>4} {:<20} {:<10} {:>7} {:>4} {:>5}  VENDOR / AP",
        "SSID",
        "BSSID",
        "BAND",
        "CH",
        "CTR",
        "WIDTH",
        "RSSI",
        "SECURITY",
        "PHY",
        "MAXRATE",
        "STA",
        "UTIL",
    );
    for b in list {
        let ssid = if b.hidden {
            "<hidden>".to_string()
        } else {
            trunc(&b.ssid, 24)
        };
        println!(
            "{:<24} {:<17} {:>4} {:>4} {:>4} {:>5} {:>4} {:<20} {:<10} {:>7} {:>4} {:>5}  {}{}{}",
            ssid,
            b.bssid,
            wifi_core::channel::band_label(b.band).replace(" GHz", ""),
            b.channel,
            b.center_channel,
            b.width_mhz,
            b.rssi_dbm,
            trunc(&b.security.label, 20),
            b.phy_modes.join("/"),
            b.max_rate_mbps
                .map(|r| format!("{r:.0}"))
                .unwrap_or_default(),
            b.bss_load
                .as_ref()
                .map(|l| l.station_count.to_string())
                .unwrap_or_default(),
            b.bss_load
                .as_ref()
                .map(|l| format!("{:.0}%", l.channel_utilization_pct))
                .unwrap_or_default(),
            b.vendor.clone().unwrap_or_default(),
            if b.ap_name.is_some() && b.vendor.is_some() {
                " / "
            } else {
                ""
            },
            b.ap_name.clone().unwrap_or_default(),
        );
    }
}

/// Split "/scan?iface=wlan0" into ("/scan", Some("wlan0")); the value is percent-decoded.
fn route(target: &str) -> (&str, Option<String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let iface = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("iface="))
        .filter(|v| !v.is_empty())
        .map(pct_decode);
    (path, iface)
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok());
        match (b[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

type Scan = Result<wifi_scan::ScanOutput, String>;
/// Last scan: (finished at, iface asked for, result).
type LastScan = Option<(Instant, Option<String>, Scan)>;

/// Run one scan at a time (the radio can't do two). A request that waited while another scan of the
/// same iface was running reuses that result instead of queueing a second ~7 s scan.
fn serve_scan(last: &std::sync::Mutex<LastScan>, iface: Option<String>) -> Scan {
    let asked = Instant::now();
    let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, i, scan)) = last.as_ref() {
        if *at > asked && *i == iface {
            return scan.clone();
        }
    }
    let opts = ScanOptions {
        interface: iface.clone(),
        trigger: true,
        wait: true,
    };
    let scan = wifi_scan::scan(&opts).map_err(|e| e.to_string());
    *last = Some((Instant::now(), iface, scan.clone()));
    scan
}

/// The desktop UI as one HTML file for browsers (iPad etc.), built by `npm run build:probe`.
const UI: &str = include_str!("../ui/index.html");

fn handle(
    stream: std::net::TcpStream,
    default_iface: Option<String>,
    last: &std::sync::Mutex<LastScan>,
    oui: Option<&OuiDb>,
) {
    use std::io::{BufRead, BufReader};
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return;
    }
    let target = line.split_whitespace().nth(1).unwrap_or("/");
    let (path, iface) = route(target);
    let iface = iface.or(default_iface);
    let (status, body) = match path {
        "/" => (
            "200 OK",
            serde_json::json!({"app": "wifisight-probe", "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS}).to_string(),
        ),
        "/interfaces" => match wifi_scan::interfaces() {
            Ok(l) => ("200 OK", serde_json::to_string(&l).unwrap()),
            Err(e) => ("500 Internal Server Error", e.to_string()),
        },
        "/scan" => match serve_scan(last, iface) {
            Ok(o) => ("200 OK", serde_json::to_string(&o).unwrap()),
            Err(e) => ("500 Internal Server Error", e),
        },
        // what `scan --json` prints (default sort: RSSI)
        "/bss" => match serve_scan(last, iface) {
            Ok(o) => {
                let mut snap = Snapshot::new(o.interface, &o.bss, o.warnings, oui);
                sort(&mut snap.bss, Sort::Rssi);
                ("200 OK", serde_json::to_string(&snap).unwrap())
            }
            Err(e) => ("500 Internal Server Error", e),
        },
        "/ui" => ("200 OK", UI.to_string()),
        // no scan lock: a link read doesn't touch the radio, and the GUI polls it every second
        "/link" => match wifi_scan::link(iface.as_deref()) {
            Ok(l) => ("200 OK", serde_json::to_string(&l).unwrap()),
            Err(e) => ("500 Internal Server Error", e.to_string()),
        },
        _ => ("404 Not Found", "not found".into()),
    };
    // polled every second: only log failures
    if path != "/link" || !status.starts_with("200") {
        eprintln!(
            "{} {target} -> {status}",
            line.split_whitespace().next().unwrap_or("?")
        );
    }
    let ct = if path == "/ui" {
        "text/html; charset=utf-8"
    } else {
        "application/json"
    };
    let mut w = &stream;
    let _ = write!(
        w,
        "HTTP/1.0 {status}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // Closing with request headers still unread makes Linux send RST, which can make the client drop
    // the end of the response (the 120 KB /ui). Half-close, then read until the client closes.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = std::io::copy(
        &mut std::io::Read::take(&stream, 1 << 20),
        &mut std::io::sink(),
    );
}

// ponytail: no auth, read-only, thread per connection — meant for a trusted network.
fn serve(listen: &str, default_iface: Option<String>, oui: Option<OuiDb>) {
    let listener = std::net::TcpListener::bind(listen)
        .unwrap_or_else(|e| die(format!("cannot listen on {listen}: {e}")));
    eprintln!("wifisight probe listening on http://{listen}");
    let last: &'static std::sync::Mutex<LastScan> = Box::leak(Box::default());
    let oui: &'static Option<OuiDb> = Box::leak(Box::new(oui));
    for stream in listener.incoming().flatten() {
        let iface = default_iface.clone();
        std::thread::spawn(move || handle(stream, iface, last, oui.as_ref()));
    }
}

fn cmd_scan(opts: ScanOptions, json: bool, raw: bool, by: Sort, oui: Option<&OuiDb>) {
    let o = wifi_scan::scan(&opts).unwrap_or_else(|e| die(e));
    for w in &o.warnings {
        eprintln!("warning: {w}");
    }
    if raw {
        println!("{}", serde_json::to_string_pretty(&o.bss).unwrap());
        return;
    }
    let mut snap = Snapshot::new(o.interface, &o.bss, o.warnings, oui);
    sort(&mut snap.bss, by);
    if json {
        println!("{}", serde_json::to_string_pretty(&snap).unwrap());
    } else {
        eprintln!("{} BSS on {}", snap.bss.len(), snap.interface);
        print_table(&snap.bss);
    }
}

fn cmd_watch(
    opts: ScanOptions,
    interval: f64,
    out: Option<std::path::PathBuf>,
    full: bool,
    count: u64,
    oui: Option<&OuiDb>,
) {
    let mut w: Box<dyn Write> = match &out {
        Some(p) => Box::new(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .unwrap_or_else(|e| die(format!("cannot open {}: {e}", p.display()))),
        ),
        None => Box::new(std::io::stdout()),
    };
    let mut n = 0u64;
    loop {
        let t0 = Instant::now();
        match wifi_scan::scan(&opts) {
            Ok(o) => {
                let snap = Snapshot::new(o.interface, &o.bss, o.warnings, oui);
                let bss = if full {
                    serde_json::to_value(&snap.bss)
                } else {
                    serde_json::to_value(snap.bss.iter().map(compact).collect::<Vec<_>>())
                }
                .unwrap();
                // keys predate `Snapshot` (ts / iface); kept for existing JSONL consumers
                let line = serde_json::json!({"ts": snap.timestamp_ms, "iface": snap.interface, "warnings": snap.warnings, "bss": bss});
                let _ = writeln!(w, "{line}");
                let _ = w.flush();
                if out.is_some() {
                    eprintln!("[{}] {} BSS", n + 1, snap.bss.len());
                }
            }
            Err(e) => eprintln!("scan error: {e}"),
        }
        n += 1;
        if count > 0 && n >= count {
            break;
        }
        let wait = Duration::from_secs_f64(interval).saturating_sub(t0.elapsed());
        std::thread::sleep(wait);
    }
}

fn main() {
    let cli = Cli::parse();
    let oui = cli
        .oui
        .as_ref()
        .and_then(|p| {
            std::fs::read_to_string(p)
                .map_err(|e| eprintln!("warning: cannot read {}: {e}", p.display()))
                .ok()
        })
        .map(|t| OuiDb::from_ieee_csv(&t));
    match cli.cmd {
        Cmd::Serve { listen, iface } => serve(&listen, iface, oui),
        Cmd::Link { iface } => {
            let l = wifi_scan::link(iface.as_deref()).unwrap_or_else(|e| die(e));
            println!("{}", serde_json::to_string(&l).unwrap());
        }
        Cmd::Interfaces => {
            for i in wifi_scan::interfaces().unwrap_or_else(|e| die(e)) {
                println!("{}\t{}\t{}", i.id, i.description, i.mac.unwrap_or_default());
            }
        }
        Cmd::Scan {
            iface,
            no_trigger,
            json,
            raw,
            sort,
        } => {
            let opts = ScanOptions {
                interface: iface,
                trigger: !no_trigger,
                wait: true,
            };
            cmd_scan(opts, json, raw, sort, oui.as_ref());
        }
        Cmd::Watch {
            iface,
            interval,
            out,
            full,
            count,
        } => {
            let opts = ScanOptions {
                interface: iface,
                trigger: true,
                wait: true,
            };
            cmd_watch(opts, interval, out, full, count, oui.as_ref());
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn route() {
        let some = |s: &str| Some(s.to_string());
        assert_eq!(super::route("/scan?iface=wlan1"), ("/scan", some("wlan1")));
        assert_eq!(
            super::route("/scan?x=1&iface=wlan0"),
            ("/scan", some("wlan0"))
        );
        assert_eq!(
            super::route("/scan?iface=%7Bab%2Dcd%7D"),
            ("/scan", some("{ab-cd}"))
        );
        assert_eq!(super::route("/scan?iface=a%zz"), ("/scan", some("a%zz")));
        assert_eq!(super::route("/scan?iface="), ("/scan", None));
        assert_eq!(super::route("/interfaces"), ("/interfaces", None));
    }

    #[test]
    fn ui_embedded() {
        assert!(super::UI.contains("<html"));
    }
}
