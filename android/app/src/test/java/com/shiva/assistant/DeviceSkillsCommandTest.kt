package com.shiva.assistant

import com.shiva.assistant.device.camera.CameraFacing
import com.shiva.assistant.device.camera.parseCameraFacing
import com.shiva.assistant.device.camera.parseCaptureQuality
import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus
import com.shiva.assistant.device.command.DeviceCommandWireMessage
import com.shiva.assistant.device.command.DeviceCommandWirePayload
import com.shiva.assistant.device.command.deviceCommandStatusForWire
import com.shiva.assistant.device.command.encodeDeviceCommandResult
import com.shiva.assistant.device.command.parseDeviceCommandMessage
import com.shiva.assistant.device.notifications.NotificationDetail
import com.shiva.assistant.device.notifications.NotificationSendCommandHandler
import com.shiva.assistant.device.notifications.NotificationSendController
import com.shiva.assistant.device.notifications.NotificationSendResult
import com.shiva.assistant.device.notifications.NotificationSummary
import com.shiva.assistant.device.notifications.NotificationsAccess
import com.shiva.assistant.device.notifications.NotificationsListCommandHandler
import com.shiva.assistant.device.notifications.NotificationsReadCommandHandler
import com.shiva.assistant.device.notifications.NotificationsRepository
import com.shiva.assistant.device.notifications.notificationPostingBlockReason
import com.shiva.assistant.core.network.ShivaJson
import kotlinx.serialization.encodeToString
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceSkillsCommandTest {
    @Test
    fun notificationsListReturnsDeniedWithoutAccess() = runTest {
        val handler = NotificationsListCommandHandler(DeniedNotificationsRepository)
        val result = handler.handle(
            DeviceCommand("n1", "device.notifications.list", createdAtEpochMs = 1),
        )
        assertEquals(DeviceCommandStatus.DENIED, result.status)
    }

    @Test
    fun notificationsListEncodesSummaries() = runTest {
        val handler = NotificationsListCommandHandler(FakeNotificationsRepository)
        val result = handler.handle(
            DeviceCommand(
                id = "n2",
                type = "device.notifications.list",
                arguments = mapOf("limit" to "5"),
                createdAtEpochMs = 1,
            ),
        )
        assertEquals(DeviceCommandStatus.COMPLETED, result.status)
        assertEquals("1", result.result["count"])
        assertTrue(result.result["notifications"]?.contains("WhatsApp") == true)
    }

    @Test
    fun notificationsReadReturnsDetail() = runTest {
        val handler = NotificationsReadCommandHandler(FakeNotificationsRepository)
        val result = handler.handle(
            DeviceCommand(
                id = "n3",
                type = "device.notifications.read",
                arguments = mapOf("key" to "com.whatsapp||123|1000"),
                createdAtEpochMs = 1,
            ),
        )
        assertEquals(DeviceCommandStatus.COMPLETED, result.status)
        assertTrue(result.result["notification"]?.contains("Hi there") == true)
    }

    @Test
    fun wireParserAcceptsDeviceCommandEnvelope() {
        val body = ShivaJson.encodeToString(
            DeviceCommandWireMessage(
                type = "device_command",
                command = DeviceCommandWirePayload(
                    id = "cmd-1",
                    type = "device.notifications.list",
                    createdAtEpochMs = 1,
                ),
            ),
        )
        val parsed = parseDeviceCommandMessage(body)
        assertEquals("device.notifications.list", parsed?.type)
    }

    @Test
    fun wireEncoderProducesResultEnvelope() {
        val encoded = encodeDeviceCommandResult(
            DeviceCommandResult(
                commandId = "cmd-1",
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf("count" to "0"),
            ),
        )
        assertTrue(encoded.contains("\"type\":\"device_command_result\""))
        assertTrue(encoded.contains("\"status\":\"COMPLETED\""))
        assertTrue(encoded.contains("\"commandId\":\"cmd-1\""))
    }

    @Test
    fun wireEncoderMapsExpiredToFailed() {
        val encoded = encodeDeviceCommandResult(
            DeviceCommandResult(
                commandId = "cmd-expired",
                status = DeviceCommandStatus.EXPIRED,
                error = "Command expired before execution.",
            ),
        )
        assertTrue(encoded.contains("\"status\":\"FAILED\""))
        assertFalse(encoded.contains("EXPIRED"))
    }

    @Test
    fun wireStatusMappingMatchesServerSchema() {
        assertEquals("COMPLETED", deviceCommandStatusForWire(DeviceCommandStatus.COMPLETED))
        assertEquals("FAILED", deviceCommandStatusForWire(DeviceCommandStatus.FAILED))
        assertEquals("DENIED", deviceCommandStatusForWire(DeviceCommandStatus.DENIED))
        assertEquals("UNSUPPORTED", deviceCommandStatusForWire(DeviceCommandStatus.UNSUPPORTED))
        assertEquals("FAILED", deviceCommandStatusForWire(DeviceCommandStatus.EXPIRED))
    }

    @Test
    fun notificationSendIsDeniedWithoutPostPermission() = runTest {
        val handler = NotificationSendCommandHandler(
            object : NotificationSendController {
                override fun send(title: String, body: String) =
                    NotificationSendResult.Denied("Notification permission has not been granted.")
            },
        )
        val result = handler.handle(
            DeviceCommand(
                id = "n4",
                type = "device.notification.send",
                arguments = mapOf("title" to "Test", "body" to "Hello"),
                createdAtEpochMs = 1,
            ),
        )
        assertEquals(DeviceCommandStatus.DENIED, result.status)
        assertEquals("Notification permission has not been granted.", result.error)
    }

    @Test
    fun notificationSendPostsWhenAllowed() = runTest {
        val handler = NotificationSendCommandHandler(
            object : NotificationSendController {
                override fun send(title: String, body: String) = NotificationSendResult.Sent
            },
        )
        val result = handler.handle(
            DeviceCommand(
                id = "n5",
                type = "device.notification.send",
                arguments = mapOf("title" to "Test", "body" to "Hello"),
                createdAtEpochMs = 1,
            ),
        )
        assertEquals(DeviceCommandStatus.COMPLETED, result.status)
        assertEquals("true", result.result["posted"])
    }

    @Test
    fun postingIsBlockedOnAndroid13WithoutPermission() {
        assertEquals(
            "Notification permission has not been granted.",
            notificationPostingBlockReason(
                sdkInt = 33,
                postNotificationsGranted = false,
                notificationsEnabled = true,
            ),
        )
        assertEquals(
            null,
            notificationPostingBlockReason(
                sdkInt = 33,
                postNotificationsGranted = true,
                notificationsEnabled = true,
            ),
        )
        assertEquals(
            "Notifications are disabled for Shiva.",
            notificationPostingBlockReason(
                sdkInt = 26,
                postNotificationsGranted = true,
                notificationsEnabled = false,
            ),
        )
    }

    @Test
    fun cameraFacingParser() {
        assertEquals(CameraFacing.FRONT, parseCameraFacing("front"))
        assertEquals(CameraFacing.BACK, parseCameraFacing("back"))
        assertEquals(75, parseCaptureQuality(null))
        assertEquals(70, parseCaptureQuality("70"))
        assertEquals(40, parseCaptureQuality("10"))
    }
}

private object DeniedNotificationsRepository : NotificationsRepository {
    override fun access() = NotificationsAccess.Denied
    override fun listActive(limit: Int, packageName: String?) = emptyList<NotificationSummary>()
    override fun readByKey(key: String) = null
}

private object FakeNotificationsRepository : NotificationsRepository {
    override fun access() = NotificationsAccess.Granted

    override fun listActive(limit: Int, packageName: String?) = listOf(
        NotificationSummary(
            key = "com.whatsapp||123|1000",
            packageName = "com.whatsapp",
            title = "WhatsApp",
            text = "Hi there",
            postTimeEpochMs = 1000,
        ),
    )

    override fun readByKey(key: String): NotificationDetail? = NotificationDetail(
        key = key,
        packageName = "com.whatsapp",
        title = "WhatsApp",
        text = "Hi there",
        bigText = "Hi there",
        postTimeEpochMs = 1000,
        category = "msg",
        actions = emptyList(),
    )
}
