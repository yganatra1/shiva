package com.shiva.assistant.device.notifications

import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus

class NotificationSendCommandHandler(
    private val controller: NotificationSendController,
) : DeviceCommandHandler {
    override val type: String = "device.notification.send"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val title = command.arguments["title"]
        val body = command.arguments["body"]
        if (title.isNullOrBlank() || body.isNullOrBlank()) {
            return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "Missing title or body argument.",
            )
        }
        return when (val outcome = controller.send(title, body)) {
            is NotificationSendResult.Sent -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf("posted" to "true"),
            )
            is NotificationSendResult.Denied -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.DENIED,
                error = outcome.reason,
            )
            is NotificationSendResult.Failed -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = outcome.reason,
            )
        }
    }
}
