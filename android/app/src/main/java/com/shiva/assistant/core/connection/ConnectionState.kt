package com.shiva.assistant.core.connection

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    SERVER_UNAVAILABLE,
    AUTHENTICATION_FAILED,
}

data class ConnectionSnapshot(
    val status: ConnectionStatus = ConnectionStatus.DISCONNECTED,
    val serverUrl: String? = null,
    val latencyMs: Long? = null,
    val lastSuccessfulAtEpochMs: Long? = null,
    val lastError: String? = null,
    val serverName: String? = null,
    val serverVersion: String? = null,
    val model: String? = null,
) {
    val isConnected: Boolean get() = status == ConnectionStatus.CONNECTED
    val isConnecting: Boolean get() = status == ConnectionStatus.CONNECTING

    fun label(): String = when (status) {
        ConnectionStatus.CONNECTED -> "Connected"
        ConnectionStatus.CONNECTING -> "Connecting"
        ConnectionStatus.DISCONNECTED -> "Disconnected"
        ConnectionStatus.SERVER_UNAVAILABLE -> "Server unavailable"
        ConnectionStatus.AUTHENTICATION_FAILED -> "Authentication failed"
    }
}

fun reduceConnection(
    previous: ConnectionSnapshot,
    serverUrl: String?,
    result: com.shiva.assistant.core.network.HealthResult,
    nowMs: Long,
): ConnectionSnapshot {
    val error = result.error
    val status = when {
        result.reachable -> ConnectionStatus.CONNECTED
        error is com.shiva.assistant.core.network.ShivaError.AuthenticationFailed ->
            ConnectionStatus.AUTHENTICATION_FAILED
        error is com.shiva.assistant.core.network.ShivaError.InvalidUrl ->
            ConnectionStatus.DISCONNECTED
        else -> ConnectionStatus.SERVER_UNAVAILABLE
    }
    return previous.copy(
        status = status,
        serverUrl = serverUrl,
        latencyMs = result.latencyMs,
        lastSuccessfulAtEpochMs = if (status == ConnectionStatus.CONNECTED) {
            nowMs
        } else {
            previous.lastSuccessfulAtEpochMs
        },
        lastError = error?.technicalMessage,
        serverName = result.name ?: previous.serverName,
        serverVersion = result.version ?: previous.serverVersion,
        model = result.model ?: previous.model,
    )
}
