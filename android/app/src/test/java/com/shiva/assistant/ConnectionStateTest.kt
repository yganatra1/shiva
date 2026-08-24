package com.shiva.assistant

import com.shiva.assistant.core.connection.ConnectionStatus
import com.shiva.assistant.core.connection.reduceConnection
import com.shiva.assistant.core.network.HealthResult
import com.shiva.assistant.core.network.ShivaError
import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionStateTest {
    @Test
    fun healthyResultBecomesConnectedAndRecordsSuccess() {
        val next = reduceConnection(
            previous = com.shiva.assistant.core.connection.ConnectionSnapshot(),
            serverUrl = "http://shiva-server:3000",
            result = HealthResult(true, 42, "ok", "Shiva", "0.3.0", "gemma", null),
            nowMs = 1_000,
        )
        assertEquals(ConnectionStatus.CONNECTED, next.status)
        assertEquals(42L, next.latencyMs)
        assertEquals(1_000L, next.lastSuccessfulAtEpochMs)
    }

    @Test
    fun authFailureMapsToAuthenticationFailed() {
        val next = reduceConnection(
            previous = com.shiva.assistant.core.connection.ConnectionSnapshot(
                lastSuccessfulAtEpochMs = 50,
            ),
            serverUrl = "http://shiva-server:3000",
            result = HealthResult(false, 12, null, null, null, null, ShivaError.AuthenticationFailed()),
            nowMs = 2_000,
        )
        assertEquals(ConnectionStatus.AUTHENTICATION_FAILED, next.status)
        assertEquals(50L, next.lastSuccessfulAtEpochMs)
    }

    @Test
    fun unreachableMapsToServerUnavailable() {
        val next = reduceConnection(
            previous = com.shiva.assistant.core.connection.ConnectionSnapshot(),
            serverUrl = "http://shiva-server:3000",
            result = HealthResult(false, null, null, null, null, null, ShivaError.Unreachable("timeout")),
            nowMs = 3_000,
        )
        assertEquals(ConnectionStatus.SERVER_UNAVAILABLE, next.status)
    }
}
