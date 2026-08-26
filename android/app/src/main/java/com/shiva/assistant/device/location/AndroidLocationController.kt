package com.shiva.assistant.device.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Looper
import androidx.core.content.ContextCompat
import com.shiva.assistant.core.logging.ShivaLog
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

private const val FIX_TIMEOUT_MS = 10_000L

/** No Play Services dependency in this project, so this uses the plain platform LocationManager. */
class AndroidLocationController(
    context: Context,
) : LocationController {
    private val appContext = context.applicationContext
    private val locationManager = appContext.getSystemService(LocationManager::class.java)

    override suspend fun getLocation(): LocationResult {
        if (!hasLocationPermission()) {
            return LocationResult.Failed("Location permission has not been granted.")
        }
        val manager = locationManager
            ?: return LocationResult.Failed("Location is not available on this device.")
        if (!isLocationEnabled(manager)) {
            return LocationResult.Failed("Location services are turned off.")
        }
        val provider = bestProvider(manager)
            ?: return LocationResult.Failed("No location provider is currently available.")
        lastKnown(manager, provider)?.let { return it.toResult() }
        val fresh = withTimeoutOrNull(FIX_TIMEOUT_MS) { requestSingleFix(manager, provider) }
        return fresh?.toResult() ?: LocationResult.Failed("Could not get a location fix in time.")
    }

    private fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun isLocationEnabled(manager: LocationManager): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return manager.isLocationEnabled
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }

    private fun bestProvider(manager: LocationManager): String? = when {
        manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
        manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
        else -> null
    }

    @Suppress("MissingPermission")
    private fun lastKnown(manager: LocationManager, provider: String): Location? {
        return manager.getLastKnownLocation(provider)
    }

    @Suppress("MissingPermission", "DEPRECATION")
    private suspend fun requestSingleFix(manager: LocationManager, provider: String): Location? =
        suspendCancellableCoroutine { continuation ->
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    manager.removeUpdates(this)
                    if (continuation.isActive) continuation.resume(location)
                }

                // LocationListener only gained default (no-op) implementations of these
                // in API 30; minSdk here is 26, so they must be overridden explicitly or
                // this throws AbstractMethodError on API 26-29 devices.
                @Deprecated("Deprecated in framework, still required pre-API 30")
                override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                override fun onProviderEnabled(provider: String) {}
                override fun onProviderDisabled(provider: String) {}
            }
            continuation.invokeOnCancellation { manager.removeUpdates(listener) }
            try {
                manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            } catch (error: Exception) {
                ShivaLog.w(ShivaLog.DEVICE, "Location fix request failed", error)
                if (continuation.isActive) continuation.resume(null)
            }
        }

    private fun Location.toResult(): LocationResult = LocationResult.Found(
        latitude = latitude,
        longitude = longitude,
        accuracyMeters = accuracy,
        ageMs = System.currentTimeMillis() - time,
    )
}
