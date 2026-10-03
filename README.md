<img src="src-tauri/icons/icon.svg" width="128" alt="WiFiSight icon">

# WiFiSight

English | [日本語](README.ja.md)

WiFiSight is a Wi-Fi scanner for event NOCs. One tool covers the venue survey, post-setup verification, and monitoring during the event.

## Highlights

### AP names, not just BSSIDs

WiFiSight shows the AP name that each AP advertises in its beacons, right in the list.
No more matching BSSIDs against the controller UI: you can spot a weak or misbehaving AP on the spot.
It understands the formats used by many enterprise AP vendors.

> [!NOTE]
> APs only include their name in beacons when the controller or AP is configured to advertise it. Enable the equivalent of Aruba's `advertise-ap-name` on each SSID.

### Let an external probe do the measuring

Run `wifisight-cli serve` on a Raspberry Pi or mini PC and it takes over the measuring.
Place the probe elsewhere in the venue and monitor the RF there remotely over the LAN.

It also works as a companion device next to you.
Scanning from a PC that is connected to Wi-Fi is unreliable, because the OS throttles scans.
The probe stays unassociated and only measures, so every scan runs under the same conditions while your PC stays online over Wi-Fi.
See [docs/probe.md](docs/probe.md) (Japanese) for details.

### Same analysis on every OS

It runs on macOS, Windows, and Linux. All parsing happens in the shared `wifi-core`, so the results are the same everywhere.

![screenshot](docs/screenshot.png)

## Features

- **Scanner**: lists nearby BSSes with SSID, BSSID, vendor, AP name, channel and width, RSSI, noise, SNR, security, PHY, NSS, max PHY rate, client count, channel utilization, 11k/v/r, and country code. Also shows signal history, a 2.4/5/6 GHz spectrum, per-channel utilization, and every IE decoded
- **Survey**: click your position on a floor plan to take a measurement; the app draws heatmaps and estimates AP locations. Surveys are saved as `*.survey.json`
- **External probe**: measure from a separate device. See [docs/probe.md](docs/probe.md) (Japanese)
- **CLI**: the same analysis as the GUI, as a table, JSON, or a JSONL log
- **Export**: CSV and JSON

Filter the list with expressions like `ch:36, sec:wpa3, band:6`. Press `?` in the app for the full filter syntax and keyboard shortcuts.

## Install

Download the file for your platform from [Releases](https://github.com/tsuyopon123/wifisight/releases).

| OS | File |
|---|---|
| macOS 11+ (Apple Silicon, Intel) | `.dmg` |
| Windows 10/11 (x64) | `-setup.exe`, or `-portable.exe` to run without installing (needs WebView2, which Windows 11 includes) |
| Linux (x64, arm64) | `.deb` |

### First launch

The app is not code-signed, so you'll see a warning the first time.

- **macOS**: copy the app from the `.dmg` to Applications and open it. If it's blocked, click "Open Anyway" in System Settings › Privacy & Security
- **Windows**: on the SmartScreen dialog, click "More info", then "Run anyway"
- **Linux**: install the `.deb` with `sudo apt install ./<file>.deb`. Updating works the same way

### Permissions

Scanning needs the following permissions.

| OS | Required permission |
|---|---|
| macOS | Location Services. Without it, SSID and BSSID are unavailable. The app asks on first launch. The standalone CLI cannot get BSSIDs |
| Windows | On Windows 11 24H2 and later, turn on Settings › Privacy & security › Location › "Let desktop apps access your location" |
| Linux | Triggering a scan needs `CAP_NET_ADMIN`. For a `.deb` install, grant it with `sudo setcap cap_net_admin+ep /usr/bin/wifisight` (again after each update). Without it, the app asks NetworkManager (`nmcli`) to rescan, and falls back to cached results if that fails too |

## CLI

`wifisight-cli` is a separate download on the same release page, for `linux-x86_64`, `linux-aarch64` (e.g. Raspberry Pi), `macos-universal`, and `windows-x86_64`. Extract the `.tar.gz` (the Windows build is a plain `.exe`) and put the binary on your `PATH`:

```sh
tar -xzf wifisight-cli-<version>-linux-aarch64.tar.gz
sudo mv wifisight-cli /usr/local/bin/
```

Or install from source with Rust (stable):

```sh
cargo install --git https://github.com/tsuyopon123/wifisight wifi-cli
```

Common commands:

```sh
wifisight-cli interfaces
wifisight-cli scan                # table
wifisight-cli scan --json         # parsed JSON
wifisight-cli scan --raw          # raw data from the OS (IEs as hex)
wifisight-cli watch --interval 5 -o survey.jsonl
wifisight-cli serve               # run as an external probe on :8737
```

`--raw` output is useful for bug reports and as test data for `wifi-core`.

## Development

### Build

Requires Rust (stable) and Node.js 22.18+ (it runs the `.ts` self-check directly). On Linux, also install:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
```

```sh
npm install
npm run tauri dev     # run in development mode
npm run tauri build   # build bundles (.app/.dmg, -setup.exe, .deb)
cargo run -p wifi-cli -- scan   # run the CLI
```

On macOS, the location permission is granted per `.app`, and with `npm run tauri dev` it may go to your terminal instead. To test reliably, run the `.app` built by `npm run tauri build -- --debug`.

`npm run dev` serves the UI alone at http://localhost:1420. Scanning doesn't work in a browser, so the scan area shows an error.

### Layout

The per-OS scanners only collect raw BSS data and IEs; all parsing happens in the shared `wifi-core`.

| Path | Contents |
|---|---|
| `crates/wifi-core` | IE parsing (OS-independent) |
| `crates/wifi-scan` | Per-OS scanners (CoreWLAN on macOS, Native Wifi API on Windows, nl80211 on Linux) |
| `crates/wifi-cli` | CLI (`wifisight-cli`) |
| `src-tauri` | Tauri backend |
| `src` | UI (TypeScript, Canvas) |

### Tests

```sh
cargo test -p wifi-core -p wifi-scan -p wifi-cli
node src/heatmap.check.ts    # heatmap self-check
```

GitHub Actions runs the tests on macOS, Windows, and Ubuntu and builds the CLI and GUI bundles. Pushing a `v*` tag creates a draft release with the bundles attached.

## License

[MIT](LICENSE)
