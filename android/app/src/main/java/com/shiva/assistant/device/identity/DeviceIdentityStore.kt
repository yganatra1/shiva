package com.shiva.assistant.device.identity

import android.os.Build
import com.shiva.assistant.BuildConfig
import com.shiva.assistant.core.security.SecureVault

class DeviceIdentityStore(
    private val vault: SecureVault,
) {
    fun identity(deviceName: String): DeviceIdentity {
        val id = vault.getString(SecureVault.DEVICE_ID) ?: newInstallationId().also { generated ->
            vault.putString(SecureVault.DEVICE_ID, generated)
        }
        val fallbackName = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android phone"
        return DeviceIdentity(
            deviceId = id,
            deviceName = deviceName.ifBlank { fallbackName },
            appVersion = BuildConfig.VERSION_NAME,
            androidVersion = Build.VERSION.RELEASE ?: "unknown",
            deviceModel = Build.MODEL ?: "unknown",
        )
    }
}
