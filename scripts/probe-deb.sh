#!/bin/sh
# Package the external probe: wifisight-cli plus a systemd unit that runs `serve` (docs/probe.md).
# Usage: scripts/probe-deb.sh <wifisight-cli binary> <version> <amd64|arm64> <out dir>
set -eu
bin=$1 ver=$2 arch=$3 out=$4
src=$(cd "$(dirname "$0")/.." && pwd)/crates/wifi-cli/deb
root=$(mktemp -d)
chmod 755 "$root" # mktemp makes it 0700; it becomes the package's ./
trap 'rm -rf "$root"' EXIT
install -Dm755 "$bin" "$root/usr/bin/wifisight-cli"
install -Dm644 "$src/wifisight-probe.service" "$root/lib/systemd/system/wifisight-probe.service"
mkdir -p "$root/DEBIAN"
for s in postinst prerm postrm; do install -m755 "$src/$s" "$root/DEBIAN/$s"; done
# newest glibc symbol version the binary links against = the libc6 it needs
# (readelf reads any ELF: the arm64 binary is packaged on an x86_64 runner)
glibc=$(readelf -V --wide "$bin" | grep -o 'GLIBC_[0-9.]*' | cut -d_ -f2 | sort -uV | tail -1)
[ -n "$glibc" ] || { echo "no GLIBC_ version found in $bin" >&2; exit 1; }
cat > "$root/DEBIAN/control" <<CONTROL
Package: wifisight-probe
Version: $ver
Architecture: $arch
Maintainer: Tsuyoshi OHIRA
Depends: libc6 (>= $glibc)
Section: net
Priority: optional
Homepage: https://github.com/tsuyopon123/wifisight
Description: WiFiSight external probe
 Runs wifisight-cli serve as a systemd service on port 8737, so the WiFiSight
 app on the LAN can scan with this machine's Wi-Fi. The API is read-only and
 has no authentication: use it on a trusted network.
CONTROL
mkdir -p "$out"
dpkg-deb --root-owner-group --build "$root" "$out/wifisight-probe_${ver}_${arch}.deb"
