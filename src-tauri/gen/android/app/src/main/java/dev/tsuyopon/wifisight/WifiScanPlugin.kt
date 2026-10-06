package dev.tsuyopon.wifisight

import android.Manifest
import android.app.Activity
import android.content.Context
import android.location.LocationManager
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import android.os.Build
import android.os.SystemClock
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray

/**
 * Wi-Fi scanner for Android. Returns wifi_core::RawBss JSON (BSSID, frequency, RSSI, raw IEs);
 * all interpretation happens in Rust, like the desktop backends in crates/wifi-scan.
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = "location"),
        Permission(strings = [Manifest.permission.NEARBY_WIFI_DEVICES], alias = "nearby"),
    ]
)
class WifiScanPlugin(private val activity: Activity) : Plugin(activity) {
    private val wifi get() = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    // API 33+ scans with NEARBY_WIFI_DEVICES (neverForLocation); older needs fine location.
    private val alias get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "nearby" else "location"

    /** Same vocabulary as the macOS backend: authorized / denied / notDetermined. */
    private fun status() = when (getPermissionState(alias)) {
        PermissionState.GRANTED -> "authorized"
        PermissionState.DENIED -> "denied"
        else -> "notDetermined"
    }

    @Command
    fun permissionStatus(invoke: Invoke) {
        invoke.resolve(JSObject().apply { put("status", status()) })
    }

    @Command
    fun requestAccess(invoke: Invoke) {
        if (status() == "authorized") permissionStatus(invoke)
        else requestPermissionForAlias(alias, invoke, "permissionStatusCallback")
    }

    @PermissionCallback
    fun permissionStatusCallback(invoke: Invoke) = permissionStatus(invoke)

    @Command
    fun scan(invoke: Invoke) {
        if (status() != "authorized") {
            invoke.reject("permission denied: Wi-Fi scanning needs the nearby devices / location permission")
            return
        }
        val warnings = JSONArray()
        // startScan() doesn't wait: getScanResults() below returns the previous scan.
        @Suppress("DEPRECATION")
        if (!wifi.startScan()) {
            warnings.put("scan throttled (Android allows 4 scans / 2 min): turn off Developer options › Wi-Fi scan throttling")
        }
        val results = try {
            wifi.scanResults
        } catch (e: SecurityException) {
            invoke.reject("permission denied: ${e.message}")
            return
        }
        if (results.isEmpty()) {
            val lm = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            if (!lm.isLocationEnabled) warnings.put("Location is off: Android returns no scan results until it's on")
        }
        @Suppress("DEPRECATION")
        val connected = wifi.connectionInfo?.bssid?.lowercase()
        val nowUs = SystemClock.elapsedRealtimeNanos() / 1000
        val bss = JSONArray()
        for (r in results) bss.put(toRawBss(r, connected, nowUs))
        invoke.resolve(JSObject().apply {
            put("bss", bss)
            put("warnings", warnings)
        })
    }

    private fun toRawBss(r: ScanResult, connected: String?, nowUs: Long): JSObject {
        val ies = StringBuilder()
        var hasSsidIe = false
        for (e in r.informationElements) {
            // getBytes() is a read-only buffer without the id/len header (and without the ext id for 255)
            val body = ByteArray(e.bytes.remaining()).also { e.bytes.duplicate().get(it) }
            if (e.id == 0) hasSsidIe = true
            if (e.id == 255) ies.hex(255).hex(body.size + 1).hex(e.idExt)
            else ies.hex(e.id).hex(body.size)
            for (b in body) ies.hex(b.toInt())
        }
        val o = JSObject()
        o.put("bssid", JSONArray(r.BSSID.split(":").map { it.toInt(16) }))
        @Suppress("DEPRECATION")
        if (!hasSsidIe) o.put("ssid", JSONArray(r.SSID.toByteArray().map { it.toInt() and 0xff }))
        o.put("freqMhz", r.frequency)
        o.put("rssiDbm", r.level)
        o.put("ies", ies.toString())
        o.put("ageMs", ((nowUs - r.timestamp) / 1000).coerceIn(0, Int.MAX_VALUE.toLong()))
        o.put("connected", r.BSSID.lowercase() == connected)
        when (r.channelWidth) {
            ScanResult.CHANNEL_WIDTH_20MHZ -> 20
            ScanResult.CHANNEL_WIDTH_40MHZ -> 40
            ScanResult.CHANNEL_WIDTH_80MHZ -> 80
            ScanResult.CHANNEL_WIDTH_160MHZ, ScanResult.CHANNEL_WIDTH_80MHZ_PLUS_MHZ -> 160
            5 -> 320 // CHANNEL_WIDTH_320MHZ, API 33
            else -> null
        }?.let { o.put("osChannelWidthMhz", it) }
        return o
    }

    private fun StringBuilder.hex(v: Int): StringBuilder = append("%02x".format(v and 0xff))
}
