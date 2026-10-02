# 外部 Probe

GUI を動かす PC とは別のデバイス（ミニ PC、Raspberry Pi などのシングルボードコンピュータ）で計測できる。
このデバイスを **外部 Probe** と呼ぶ。
計測専用のデバイスを分けることで、**PC の通信状況に左右されない安定した計測**ができる。

PC の Wi-Fi で計測すると、計測と通信が同じ無線を取り合う。
接続中は OS がスキャンを間引くことがあり、計測結果が PC の通信状況に左右される。
逆に、スキャン中は無線が接続中のチャネルを離れるので、通信が途切れることがある。

Probe の Wi-Fi はどのアクセスポイントにも接続せず、計測だけに使う。
そのためスキャンが間引かれず、毎回同じ条件で計測できる。
PC は Wi-Fi でインターネットにつないだまま作業を続けられる。

Probe と PC は有線でつなぐ。
Probe を会場の離れた場所に置き、LAN 越しに計測することもできる。

Probe 側で `wifisight-cli serve` を動かし、GUI の ⚙ 設定 › Probe にそのアドレスを入力する。

```
[Probe（ミニ PC、Raspberry Pi など）]  自身の Wi-Fi でスキャン
            │  wifisight-cli serve (:8737)
            │  IP で到達できるネットワーク（有線直結、LAN など）
            │
[PC]  GUI の ⚙ 設定 › Probe に <host>:8737
```

Probe は生のスキャン結果（`RawBss` と hex の IE）を HTTP で JSON として返すだけである。
解析は PC 側の `wifi-core` が行い、OUI DB も PC 側のものを使う。
そのため、Probe 側の CLI を更新しなくても PC 側の解析の改善が反映される。

## 対応するデバイス

Linux を推奨する。
`wifisight-cli` は Windows でも動くが、macOS では CLI 単体で BSSID を取得できないので Probe には向かない。

6 GHz を計測するには、6 GHz に対応した Wi-Fi（mt7921u などの USB アダプタを含む）が必要である。
複数の Wi-Fi インターフェースがあるデバイスでは、GUI の Interface 一覧から計測に使うものを選ぶ。

## セットアップ（Linux）

1. `wifisight-cli` を `/usr/local/bin/` に置く。
   [Releases](https://github.com/tsuyopon123/wifisight/releases) の `wifisight-cli-<バージョン>-linux-x86_64.tar.gz`（Raspberry Pi などの aarch64 機では `linux-aarch64`）を展開して使うか、デバイス上で `cargo build -p wifi-cli --release` でビルドする。

2. systemd で常駐させる。
   この設定をしておくと、デバイスの起動時に Probe として動く。

   `/etc/systemd/system/wifisight-probe.service`：

   ```ini
   [Unit]
   Description=WiFiSight probe
   After=network-online.target

   [Service]
   ExecStart=/usr/local/bin/wifisight-cli serve --listen 0.0.0.0:8737
   DynamicUser=yes
   # nl80211 でアクティブスキャンを起動するのに必要
   AmbientCapabilities=CAP_NET_ADMIN
   CapabilityBoundingSet=CAP_NET_ADMIN
   Restart=always

   [Install]
   WantedBy=multi-user.target
   ```

   ```sh
   sudo systemctl enable --now wifisight-probe
   ```

3. スキャンに使う Wi-Fi インターフェースは、どのアクセスポイントにも接続しないでおく。接続中のインターフェースではスキャンを間引くドライバがある。

## PC と有線で直結する

DHCP サーバーのない直結リンクでは、リンクローカルアドレス（169.254.x.x）と mDNS で PC から Probe に到達できる。
Probe はデフォルトルートを配らないので、PC のインターネット接続は Wi-Fi 側に残る。

NetworkManager を使うデバイスでは、次のように設定する。

```sh
sudo nmcli con add type ethernet ifname eth0 con-name probe-eth ipv4.method link-local ipv6.method link-local
sudo nmcli con up probe-eth
sudo hostnamectl set-hostname wifiprobe     # PC からは wifiprobe.local として見える
```

既定の DHCP プロファイル（`Wired connection 1` など）が優先されて IP アドレスが付かないときは、そのプロファイルを削除するか `autoconnect no` にする。

PC 側の設定は不要である。
DHCP サーバーがない Ethernet には、macOS が 169.254.x.x のアドレスを自動で割り当てる。

## 使い方

GUI の ⚙ 設定 › Probe に `<host>:8737`（直結の例では `wifiprobe.local:8737`）を入力する。
Interface の一覧が Probe 側のものに切り替わり、ステータスバーのインターフェース名が `probe:wlan0` のようになる。
Probe 欄を空にすると PC の Wi-Fi での計測に戻る。

Probe の応答は CLI からも確認できる。

```sh
curl wifiprobe.local:8737/scan | jq '.bss | length'
```

API は次の 3 つである。

| エンドポイント | 内容 |
|---|---|
| `GET /` | ヘルスチェック（アプリ名、バージョン、OS） |
| `GET /interfaces` | Wi-Fi インターフェースの一覧 |
| `GET /scan?iface=wlan0` | スキャン結果 |

## セキュリティ

API に認証はない（読み取り専用）。
信頼できるネットワークだけで使い、必要なら `--listen <IP>:8737` で待ち受けるアドレスを絞る。

## トラブルシュート

| 症状 | 確認すること |
|---|---|
| `wifiprobe.local` の名前解決ができない | Probe で `systemctl status avahi-daemon` を確認する。解決できなければ、Probe の IP アドレスを Probe 欄に直接入れる |
| `permission denied` の警告が出る | unit の `AmbientCapabilities=CAP_NET_ADMIN` が有効か確認する。この権限がないと、Probe は前回のキャッシュ結果しか返さない |
| Raspberry Pi でスキャンが遅い、または失敗する | 電圧低下の可能性がある。`vcgencmd get_throttled` が `0x0` 以外なら、電源かケーブルの給電能力が足りない |
| 直結したら PC のインターネット接続が切れた | Probe の eth0 が `link-local` になっているか（DHCP でルーターを配っていないか）を確認する |

## Probe なしでの動作確認

PC 自身で `serve` を動かすと、Probe 経由の動作を確認できる。

```sh
cargo run -p wifi-cli -- serve --listen 127.0.0.1:8737
```

GUI の ⚙ 設定 › Probe に `127.0.0.1:8737` を入力する。
