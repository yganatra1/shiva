package com.shiva.assistant.device.status

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager

class AndroidDeviceStatusController(
    context: Context,
) : DeviceStatusController {
    private val appContext = context.applicationContext

    override fun getStatus(): DeviceStatusResult {
        val batteryManager = appContext.getSystemService(BatteryManager::class.java)
            ?: return DeviceStatusResult.Failed("Battery information is not available.")
        val batteryPercent = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = batteryManager.isCharging

        val connectivityManager = appContext.getSystemService(ConnectivityManager::class.java)
        val capabilities = connectivityManager?.activeNetwork?.let {
            connectivityManager.getNetworkCapabilities(it)
        }
        val networkType = when {
            capabilities == null -> "none"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        return DeviceStatusResult.Found(
            batteryPercent = batteryPercent,
            charging = charging,
            networkType = networkType,
            connected = capabilities != null,
        )
    }
}
