package com.shiva.assistant

import com.shiva.assistant.core.network.mapHttpFailure
import com.shiva.assistant.core.network.mapIoFailure
import com.shiva.assistant.core.network.ShivaError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class NetworkErrorMappingTest {
    @Test
    fun unauthorizedBecomesAuthenticationFailed() {
        val error = mapHttpFailure(401, null)
        assertTrue(error is ShivaError.AuthenticationFailed)
    }

    @Test
    fun parsesPublicApiError() {
        val error = mapHttpFailure(
            404,
            """{"error":{"code":"CONVERSATION_NOT_FOUND","message":"The requested conversation does not exist."}}""",
        )
        assertTrue(error is ShivaError.Api)
        error as ShivaError.Api
        assertEquals("CONVERSATION_NOT_FOUND", error.code)
        assertEquals("The requested conversation does not exist.", error.publicMessage)
    }

    @Test
    fun timeoutIoMapsToTimeout() {
        val error = mapIoFailure(SocketTimeoutException("timed out"))
        assertTrue(error is ShivaError.Timeout)
    }

    @Test
    fun unknownHostMapsToUnreachable() {
        val error = mapIoFailure(UnknownHostException("shiva-server"))
        assertTrue(error is ShivaError.Unreachable)
    }
}
