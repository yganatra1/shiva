package com.shiva.assistant

import com.shiva.assistant.core.network.ServerUrl
import com.shiva.assistant.core.network.ServerUrlParseResult
import com.shiva.assistant.core.network.coreUpdateWebSocketUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlTest {
    @Test
    fun acceptsMagicDnsWithPort() {
        val parsed = ServerUrl.parse("http://shiva-server:3000")
        assertTrue(parsed is ServerUrlParseResult.Valid)
        assertEquals("http://shiva-server:3000", (parsed as ServerUrlParseResult.Valid).url.origin())
    }

    @Test
    fun addsHttpWhenSchemeMissing() {
        val parsed = ServerUrl.parse("shiva-server:3000")
        assertTrue(parsed is ServerUrlParseResult.Valid)
        assertEquals("http://shiva-server:3000", (parsed as ServerUrlParseResult.Valid).url.origin())
    }

    @Test
    fun rejectsLocalhost() {
        val parsed = ServerUrl.parse("http://127.0.0.1:3000")
        assertTrue(parsed is ServerUrlParseResult.Invalid)
    }

    @Test
    fun rejectsPath() {
        val parsed = ServerUrl.parse("http://shiva-server:3000/chat")
        assertTrue(parsed is ServerUrlParseResult.Invalid)
    }

    @Test
    fun stripsTrailingSlash() {
        val parsed = ServerUrl.parse("http://100.64.0.12:3000/")
        assertTrue(parsed is ServerUrlParseResult.Valid)
        assertEquals("http://100.64.0.12:3000", (parsed as ServerUrlParseResult.Valid).url.origin())
        assertEquals(
            "http://100.64.0.12:3000/health",
            parsed.url.resolve("/health"),
        )
    }

    @Test
    fun rejectsEmpty() {
        assertTrue(ServerUrl.parse("   ") is ServerUrlParseResult.Invalid)
    }

    @Test
    fun buildsCoreUpdateWebSocketUrlWithReplayCursor() {
        assertEquals(
            "wss://shiva.example/chat/updates?conversationId=conversation-1&afterMessageId=message-1&limit=100",
            coreUpdateWebSocketUrl(
                origin = "https://shiva.example",
                conversationId = "conversation-1",
                afterMessageId = "message-1",
            ),
        )
    }
}
