package com.shiva.assistant.device.notifications

import com.shiva.assistant.core.network.ShivaJson
import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus
import kotlinx.serialization.encodeToString

class NotificationsReadCommandHandler(
    private val repository: NotificationsRepository,
) : DeviceCommandHandler {
    override val type: String = "device.notifications.read"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        if (repository.access() == NotificationsAccess.Denied) {
            return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.DENIED,
                error = "Notification access is not enabled for Shiva.",
            )
        }
        val key = command.arguments["key"]?.takeIf { it.isNotBlank() }
            ?: return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "Missing notification key.",
            )
        val detail = repository.readByKey(key)
            ?: return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "Notification not found.",
            )
        return DeviceCommandResult(
            commandId = command.id,
            status = DeviceCommandStatus.COMPLETED,
            result = mapOf(
                "notification" to ShivaJson.encodeToString(detail),
            ),
        )
    }
}
