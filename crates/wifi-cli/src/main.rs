//! wifisight-cli — headless scanner/logger sharing the GUI's analysis engine.

use clap::{Parser, Subcommand};
use serde::Serialize;
use std::io::Write;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wifi_core::{analyze, BssInfo, OuiDb, RawBss};
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
        /// Sort by: rssi | channel | ssid
        #[arg(long, default_value = "rssi")]
        sort: String,
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
    /// Run as an external probe: serve raw scans over HTTP (GET /, /interfaces, /scan?iface=X)
    Serve {
        /// Address to listen on (e.g. the direct Ethernet link: 169.254.x.x:8737)
        #[arg(long, default_value = "0.0.0.0:8737")]
        listen: String,
        /// Default interface when the request has no ?iface=
        #[arg(short, long)]
        iface: Option<String>,
    },
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn do_scan(opts: &ScanOptions) -> Result<(String, Vec<RawBss>, Vec<String>), String> {
    let o = wifi_scan::scan(opts).map_err(|e| e.to_string())?;
    Ok((o.interface, o.bss, o.warnings))
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

/// Last /scan answer: (finished at, iface asked for, status, body).
type LastScan = Option<(Instant, Option<String>, &'static str, String)>;

/// Run one scan at a time (the radio can't do two). A request that waited while another scan of the
/// same iface was running reuses that result instead of queueing a second ~7 s scan.
fn serve_scan(last: &std::sync::Mutex<LastScan>, iface: Option<String>) -> (&'static str, String) {
    let asked = Instant::now();
    let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, i, status, body)) = last.as_ref() {
        if *at > asked && *i == iface {
            return (status, body.clone());
        }
    }
    let opts = ScanOptions {
        interface: iface.clone(),
        trigger: true,
        wait: true,
    };
    let (status, body) = match do_scan(&opts) {
        Ok((interface, bss, warnings)) => (
            "200 OK",
            serde_json::to_string(&wifi_scan::ScanOutput {
                interface,
                bss,
                warnings,
            })
            .unwrap(),
        ),
        Err(e) => ("500 Internal Server Error", e),
    };
    *last = Some((Instant::now(), iface, status, body.clone()));
    (status, body)
}

fn handle(
    stream: std::net::TcpStream,
    default_iface: Option<String>,
    last: &std::sync::Mutex<LastScan>,
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
        "/scan" => serve_scan(last, iface),
        _ => ("404 Not Found", "not found".into()),
    };
    eprintln!(
        "{} {target} -> {status}",
        line.split_whitespace().next().unwrap_or("?")
    );
    let mut w = &stream;
    let _ = write!(
        w,
        "HTTP/1.0 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

// ponytail: no auth, read-only, thread per connection — meant for a point-to-point Ethernet / USB link.
fn serve(listen: &str, default_iface: Option<String>) {
    let listener = std::net::TcpListener::bind(listen).unwrap_or_else(|e| {
        eprintln!("cannot listen on {listen}: {e}");
        std::process::exit(1)
    });
    eprintln!("wifisight probe listening on http://{listen}");
    let last: &'static std::sync::Mutex<LastScan> = Box::leak(Box::default());
    for stream in listener.incoming().flatten() {
        let iface = default_iface.clone();
        std::thread::spawn(move || handle(stream, iface, last));
    }
}

fn main() {
    let cli = Cli::parse();
    let oui = cli
        .oui
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| OuiDb::from_ieee_csv(&t));
    match cli.cmd {
        Cmd::Serve { listen, iface } => serve(&listen, iface),
        Cmd::Interfaces => match wifi_scan::interfaces() {
            Ok(list) => {
                for i in list {
                    println!("{}\t{}\t{}", i.id, i.description, i.mac.unwrap_or_default());
                }
            }
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        },
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
            let (ifname, raws, warnings) = do_scan(&opts).unwrap_or_else(|e| {
                eprintln!("error: {e}");
                std::process::exit(1);
            });
            for w in &warnings {
                eprintln!("warning: {w}");
            }
            if raw {
                println!("{}", serde_json::to_string_pretty(&raws).unwrap());
                return;
            }
            let mut list: Vec<BssInfo> = raws.iter().map(|r| analyze(r, oui.as_ref())).collect();
            match sort.as_str() {
                "channel" => list.sort_by_key(|b| (b.freq_mhz, -b.rssi_dbm)),
                "ssid" => {
                    list.sort_by(|a, b| a.ssid.cmp(&b.ssid).then(b.rssi_dbm.cmp(&a.rssi_dbm)))
                }
                _ => list.sort_by_key(|b| -b.rssi_dbm),
            }
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "timestampMs": now_ms() as u64,
                        "interface": ifname,
                        "warnings": warnings,
                        "bss": list,
                    }))
                    .unwrap()
                );
            } else {
                eprintln!("{} BSS on {}", list.len(), ifname);
                print_table(&list);
            }
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
            let mut w: Box<dyn Write> = match &out {
                Some(p) => Box::new(
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(p)
                        .unwrap_or_else(|e| {
                            eprintln!("cannot open {}: {e}", p.display());
                            std::process::exit(1)
                        }),
                ),
                None => Box::new(std::io::stdout()),
            };
            let mut n = 0u64;
            loop {
                let t0 = Instant::now();
                match do_scan(&opts) {
                    Ok((ifname, raws, warnings)) => {
                        let list: Vec<BssInfo> =
                            raws.iter().map(|r| analyze(r, oui.as_ref())).collect();
                        let line = if full {
                            serde_json::json!({"ts": now_ms() as u64, "iface": ifname, "warnings": warnings, "bss": list})
                        } else {
                            let c: Vec<_> = list.iter().map(compact).collect();
                            serde_json::json!({"ts": now_ms() as u64, "iface": ifname, "warnings": warnings, "bss": c})
                        };
                        let _ = writeln!(w, "{line}");
                        let _ = w.flush();
                        if out.is_some() {
                            eprintln!("[{}] {} BSS", n + 1, list.len());
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
}
