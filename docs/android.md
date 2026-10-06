# Android ビルド（未リリース）

端末自身の Wi-Fi をスキャンする。スキャンは Kotlin のプラグイン（[WifiScanPlugin.kt](../src-tauri/gen/android/app/src/main/java/dev/tsuyopon/wifisight/WifiScanPlugin.kt)）が `WifiManager` から生の IE を取り出して `RawBss` を返し、解析はデスクトップ版と同じ `wifi-core` で行う。
Android 11（API 30）以上が対象。生の IE を取る `ScanResult.getInformationElements()` が API 30 以上でしか使えないため。

## 開発環境（macOS）

```sh
brew install --cask temurin@17 android-commandlinetools
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;29.0.14206865"
export NDK_HOME=$ANDROID_HOME/ndk/29.0.14206865
rustup target add aarch64-linux-android
```

Homebrew の `rust` も入っている場合は、PATH の先頭にある Homebrew の rustc が使われる。この rustc には Android ターゲットが入っていないので、ビルドは `can't find crate for std` で失敗する。rustup のツールチェーンを先頭に置く:

```sh
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH"
```

## ビルドとインストール

```sh
npx tauri android build --debug --apk --target aarch64   # app-universal-debug.apk
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
npx tauri android dev                                    # 接続した実機でホットリロード
```

release ビルドは `npx tauri android build --apk --target aarch64` で作る。release ビルドには R8（コード縮小）がかかるが、プラグインのクラスは Tauri の consumer rules（`@TauriPlugin` を keep する設定）で残る。

## リリース用の署名

`src-tauri/gen/android/keystore.properties` があれば、release APK はその鍵で署名される。無ければ `-unsigned.apk` が出る。鍵とこのファイルはコミットしない（gitignore 済み）。updater の minisign 鍵とは別の鍵。

```sh
keytool -genkey -v -keystore ~/.android/wifisight-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias wifisight
```

```properties
# src-tauri/gen/android/keystore.properties
storeFile=/Users/<you>/.android/wifisight-release.jks
keyAlias=wifisight
password=...
```

一度配った APK を更新するには同じ鍵での署名が必要。鍵を失くすと、利用者はアンインストールしないと更新できなくなる。

## versionCode

Tauri は `major*1000000 + minor*1000 + patch` で versionCode を作るので、`-beta.N` / `-release.N` の違いが入らない。リリースするときは、タグから計算した値を config で渡す:

```
versionCode = X*1000000 + Y*10000 + Z*100 + N   (vX.Y.Z-beta.N の N。-release.N は 99)
```

```sh
npx tauri android build --apk --target aarch64 --config '{"version":"0.2.0-beta.3","bundle":{"android":{"versionCode":2000003}}}'
```

## Android 版の制約

- **スキャン回数の上限**: フォアグラウンドでも 2 分間に 4 回まで。超えるとキャッシュされた結果が返り、ステータスバーに警告が出る。現場で使うときは、開発者向けオプションの「Wi-Fi スキャン スロットリング」をオフにする。
- **権限**: どのバージョンでも「正確な位置情報」の権限が要る。「付近のデバイス」の権限だけではスキャンが拒否され、結果は空になる（Pixel 6a / API 37 で確認）。「おおよその位置情報」を選んだ場合もスキャンできない。端末の位置情報設定がオフのときも結果が空になる。
- **取れない値**: ノイズ、Capability、ビーコン間隔は OS が渡さないので空欄になる。
- **インターフェース**: `wlan0` 固定。外部 Probe にはデスクトップ版と同じように接続できる。
- **アップデート**: アプリ内の更新は無い。GitHub Releases から APK を入れ直す。

## ベンダー IE のサンプル収集

Export ▾ › Session log (JSON)、または詳細ペインの Export JSON… で保存した JSON では、`info.ies[].hex` に各要素の本体（id/len を除いた部分）が入っている。id 221 の場合は OUI＋type＋payload で、`vendor_ap_name` のテスト（`crates/wifi-core/src/ie.rs`）にそのまま使える。
