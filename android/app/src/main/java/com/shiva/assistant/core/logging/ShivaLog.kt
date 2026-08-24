package com.shiva.assistant.core.logging

import android.util.Log

object ShivaLog {
    const val NETWORK = "Shiva.Network"
    const val CHAT = "Shiva.Chat"
    const val DEVICE = "Shiva.Device"
    const val CAPABILITIES = "Shiva.Capabilities"
    const val CONNECTION = "Shiva.Connection"

    fun d(tag: String, message: String) {
        Log.d(tag, sanitize(message))
    }

    fun i(tag: String, message: String) {
        Log.i(tag, sanitize(message))
    }

    fun w(tag: String, message: String, throwable: Throwable? = null) {
        if (throwable == null) {
            Log.w(tag, sanitize(message))
        } else {
            Log.w(tag, sanitize(message), throwable)
        }
    }

    fun e(tag: String, message: String, throwable: Throwable? = null) {
        if (throwable == null) {
            Log.e(tag, sanitize(message))
        } else {
            Log.e(tag, sanitize(message), throwable)
        }
    }

    internal fun sanitize(message: String): String {
        return SENSITIVE.replace(message, "$1[redacted]")
            .replace(BEARER, "Bearer [redacted]")
    }

    private val SENSITIVE = Regex(
        "(?i)((?:authorization|token|password|secret|credential|cookie)\\s*[=:]\\s*).+",
    )
    private val BEARER = Regex("(?i)Bearer\\s+\\S+")
}
