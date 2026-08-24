package com.shiva.assistant

import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandRouter
import com.shiva.assistant.device.command.DeviceCommandStatus
import com.shiva.assistant.device.phone.PhoneCommandHandler
import com.shiva.assistant.device.phone.PhoneController
import com.shiva.assistant.device.phone.PhoneResult
import com.shiva.assistant.device.phone.normalizePhoneNumber
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceCommandRouterTest {
    @Test
    fun routesRegisteredHandler() = runTest {
        val router = DeviceCommandRouter(
            listOf(
                PhoneCommandHandler(object : PhoneController {
                    override fun call(number: String) = PhoneResult.Failed("unused")
                    override fun dial(number: String) = PhoneResult.Started(number, false)
                }),
            ),
        )
        val result = router.dispatch(
            DeviceCommand(
                id = "cmd-1",
                type = "device.phone.call",
                arguments = mapOf("number" to "+15551212"),
                createdAtEpochMs = 1,
            ),
        )
        assertEquals(DeviceCommandStatus.COMPLETED, result.status)
        assertEquals("+15551212", result.result["number"])
    }

    @Test
    fun unknownTypeIsUnsupported() = runTest {
        val router = DeviceCommandRouter(emptyList())
        val result = router.dispatch(
            DeviceCommand("x", "device.whatsapp.send", createdAtEpochMs = 1),
        )
        assertEquals(DeviceCommandStatus.UNSUPPORTED, result.status)
    }

    @Test
    fun expiredCommandDoesNotRun() = runTest {
        val ran = arrayOf(false)
        val router = DeviceCommandRouter(
            listOf(object : DeviceCommandHandler {
                override val type = "device.phone.call"
                override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
                    ran[0] = true
                    return DeviceCommandResult(command.id, DeviceCommandStatus.COMPLETED)
                }
            }),
        )
        val result = router.dispatch(
            DeviceCommand("x", "device.phone.call", createdAtEpochMs = 1, expiresAtEpochMs = 5),
            nowMs = 10,
        )
        assertEquals(DeviceCommandStatus.EXPIRED, result.status)
        assertEquals(false, ran[0])
    }

    @Test
    fun phoneNumbersRejectJunk() {
        assertEquals("+15550001", normalizePhoneNumber(" +15550001 "))
        assertNull(normalizePhoneNumber("abc"))
        assertNull(normalizePhoneNumber("12"))
    }
}
