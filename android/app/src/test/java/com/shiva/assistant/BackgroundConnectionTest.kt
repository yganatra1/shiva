package com.shiva.assistant

import com.shiva.assistant.core.connection.ReconnectBackoff
import com.shiva.assistant.core.network.deviceWebSocketUrl
import com.shiva.assistant.core.network.httpOriginToWebSocket
import org.junit.Assert.assertEquals
import org.junit.Test

class BackgroundConnectionTest {
    @Test
    fun webSocketUrlUsesWsScheme() {
        assertEquals(
            "ws://shiva-server:3000/device/ws",
            httpOriginToWebSocket("http://shiva-server:3000", "/device/ws"),
        )
        assertEquals(
            "wss://shiva-server:3000/device/ws",
            httpOriginToWebSocket("https://shiva-server:3000", "/device/ws"),
        )
    }

    @Test
    fun deviceWebSocketUrlAppendsTokenQueryParam() {
        assertEquals(
            "wss://shiva-server:3000/device/ws?token=secret",
            deviceWebSocketUrl("https://shiva-server:3000", "/device/ws", "secret"),
        )
        assertEquals(
            "ws://shiva-server:3000/device/ws",
            deviceWebSocketUrl("http://shiva-server:3000", "/device/ws", null),
        )
        assertEquals(
            "ws://shiva-server:3000/device/ws",
            deviceWebSocketUrl("http://shiva-server:3000", "/device/ws", "   "),
        )
    }

    @Test
    fun reconnectBackoffDoublesUntilCap() {
        val backoff = ReconnectBackoff(initialMs = 1_000, maxMs = 8_000)
        assertEquals(1_000, backoff.nextDelayMs())
        backoff.advance()
        assertEquals(2_000, backoff.nextDelayMs())
        backoff.advance()
        assertEquals(4_000, backoff.nextDelayMs())
        backoff.advance()
        assertEquals(8_000, backoff.nextDelayMs())
        backoff.advance()
        assertEquals(8_000, backoff.nextDelayMs())
        backoff.reset()
        assertEquals(1_000, backoff.nextDelayMs())
    }
}
