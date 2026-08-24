package com.shiva.assistant.core.security

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.shiva.assistant.core.logging.ShivaLog

class SecureVault(
    context: Context,
) {
    private val prefs: SharedPreferences = createPrefs(context.applicationContext)

    @Synchronized
    fun getString(key: String): String? = prefs.getString(key, null)

    @Synchronized
    fun putString(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    @Synchronized
    fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }

    private fun createPrefs(context: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (error: Exception) {
            ShivaLog.w(ShivaLog.DEVICE, "Falling back to private prefs for secure vault")
            context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        }
    }

    companion object {
        const val FILE = "shiva_secure"
        const val DEVICE_TOKEN = "device_token"
        const val DEVICE_ID = "device_id"
    }
}
