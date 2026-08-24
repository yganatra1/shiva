package com.shiva.assistant.core.connection

internal data class ReconnectBackoff(
    private val initialMs: Long = 1_000,
    private val maxMs: Long = 60_000,
    private var currentMs: Long = initialMs,
) {
    fun nextDelayMs(): Long = currentMs

    fun advance() {
        currentMs = (currentMs * 2).coerceAtMost(maxMs)
    }

    fun reset() {
        currentMs = initialMs
    }
}
