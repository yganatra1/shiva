package com.shiva.assistant.device.notifications

import com.shiva.assistant.core.network.ShivaJson
import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus
import kotlinx.serialization.encodeToString

class NotificationsListCommandHandler(
    private val repository: NotificationsRepository,
) : DeviceCommandHandler {
    override val type: String = "device.notifications.list"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        if (repository.access() == NotificationsAccess.Denied) {
            return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.DENIED,
                error = "Notification access is not enabled for Shiva.",
            )
        }
        val limit = command.arguments["limit"]?.toIntOrNull()?.coerceIn(1, 50) ?: 20
        val packageName = command.arguments["package"]?.takeIf { it.isNotBlank() }
        val items = repository.listActive(limit = limit, packageName = packageName)
        return DeviceCommandResult(
            commandId = command.id,
            status = DeviceCommandStatus.COMPLETED,
            result = mapOf(
                "count" to items.size.toString(),
                "notifications" to ShivaJson.encodeToString(items),
            ),
        )
    }
}
