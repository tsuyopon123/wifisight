<img src="src-tauri/icons/icon.svg" width="128" alt="WiFiSight icon">

# WiFiSight

English | [日本語](README.ja.md)

Website: https://wifisight.tsuyopon.dev/

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
- **Link and roaming log**: checks the associated AP every second, even while scanning is paused. The status bar shows the link rate, and the roaming log records each AP change with RSSI and TX rate before and after (see [below](#link-rates-and-roaming))
- **External probe**: measure from a separate device. See [docs/probe.md](docs/probe.md) (Japanese)
- **CLI**: the same analysis as the GUI, as a table, JSON, or a JSONL log
- **Export**: CSV and JSON

### Link rates and roaming

What each OS reports for the current link:

| OS | TX rate | RX rate | MCS / NSS |
|---|---|---|---|
| Linux | ✓ | ✓ | ✓ (HT/VHT/HE/EHT) |
| macOS | ✓ | – | ✓ (read via private CoreWLAN API; may disappear in a future macOS) |
| Windows | ✓ | ✓ | – |

macOS and Windows 11 24H2+ report the BSSID only with location access, so without it there is no link to show. On a Linux Wi-Fi 7 multi-link connection, the AP MLD address stands in for the BSSID.

Filter the list with expressions like `band:5 !sec:open, rssi<-75` (space = AND, comma = OR, `!` = NOT). Press `?` in the app for the full filter syntax and keyboard shortcuts.

## Install

Download the file for your platform from [Releases](https://github.com/tsuyopon123/wifisight/releases).

| OS | File |
|---|---|
| macOS 11+ (Apple Silicon, Intel) | `.dmg` |
| Windows 10/11 (x64) | `-setup.exe`, or `-portable.exe` to run without installing (needs WebView2, which Windows 11 includes) |
| Linux (x64, arm64) | `.deb` |

### First launch

The app is not code-signed, so you'll see a warning the first time.

- **macOS**: copy the app from the `.dmg` to Applications and open it. If it's blocked, click "Open Anyway" in System Settings › Privacy & Security. Or install with Homebrew: `brew install --cask tsuyopon123/tap/wifisight`
- **Windows**: on the SmartScreen dialog, click "More info", then "Run anyway"
- **Linux**: install the `.deb` with `sudo apt install ./<file>.deb`

### Updates

On launch, the app checks for a new release and, if there is one, shows "vX available" next to the version in the status bar. It never updates on its own.
To update, press "Check for updates" in Settings › Updates. It downloads and installs the update, then restarts (Linux asks for your password to install the `.deb`).
Turn off "Check on launch" there to skip the check on launch.
Only stable releases (plain versions such as `v0.1.1`) are offered unless you turn on "Include beta releases" there. The `-portable.exe` opens the Releases page instead of updating.

### Permissions

Scanning needs the following permissions.

| OS | Required permission |
|---|---|
| macOS | Location Services. Without it, SSID and BSSID are unavailable. The app asks on first launch. The standalone CLI cannot get BSSIDs |
| Windows | On Windows 11 24H2 and later, turn on Settings › Privacy & security › Location › "Let desktop apps access your location" |
| Linux | Triggering a scan needs `CAP_NET_ADMIN`. The `.deb` grants it on install (if that fails, run `sudo setcap cap_net_admin+ep /usr/bin/wifisight`). Without it, the app asks NetworkManager (`nmcli`) to rescan, and falls back to cached results if that fails too |

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
wifisight-cli link                # current link (BSSID, rates, MCS) as JSON
wifisight-cli serve               # run as an external probe on :8737
```

`--raw` output is useful for bug reports and as test data for `wifi-core`.

For an external probe on Linux, `wifisight-probe_<version>_<amd64|arm64>.deb` on the same page installs the CLI and a systemd service that runs `serve` on boot. See [docs/probe.md](docs/probe.md) (Japanese).

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

`npm run tauri build` also signs the in-app updater files, so it fails with "A public key has been found, but no private key" unless `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) is set. Without the key, skip those files: `npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'`.

On macOS, the location permission is granted per `.app`, and with `npm run tauri dev` it may go to your terminal instead. To test reliably, run the `.app` built by `npm run tauri build -- --debug`.

`npm run dev` serves the UI alone at http://localhost:1420. Scanning doesn't work in a browser, so the scan area shows an error.

`THIRD_PARTY_LICENSES.html` is bundled with the app and regenerated by CI on every build. To refresh it locally after changing dependencies, run `cargo about generate about.hbs -o THIRD_PARTY_LICENSES.html` (install with `cargo install cargo-about --locked --features cli`).

### Layout

The per-OS scanners only collect raw BSS data and IEs; all parsing happens in the shared `wifi-core`.

| Path | Contents |
|---|---|
| `crates/wifi-core` | IE parsing (OS-independent) |
| `crates/wifi-scan` | Per-OS scanners (CoreWLAN on macOS, Native Wifi API on Windows, nl80211 on Linux) |
| `crates/wifi-cli` | CLI (`wifisight-cli`) |
| `src-tauri` | Tauri backend |
| `src` | UI (TypeScript, Canvas) |
| `site` | Website (static HTML, published to GitHub Pages) |

### Tests

```sh
cargo test -p wifi-core -p wifi-scan -p wifi-cli
npm run check                # UI self-checks (src/*.check.ts)
npm run e2e                  # survey UI in headless Chrome (needs Chrome; set CHROME if it isn't found)
npm run screenshots          # regenerate the website screenshots in site/img/ from mock data
```

GitHub Actions runs the tests on macOS, Windows, and Ubuntu and builds the CLI and GUI bundles. Pushing a `v*` tag creates a draft release with the bundles attached.

## License

[MIT](LICENSE)
