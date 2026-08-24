package com.shiva.assistant.device.contacts

import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus

class ContactsCommandHandler(
    private val repository: ContactsRepository,
) : DeviceCommandHandler {
    override val type: String = "device.contacts.search"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val query = command.arguments["query"].orEmpty()
        val matches = repository.search(query)
        if (matches.isEmpty()) {
            return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf("count" to "0"),
            )
        }
        val first = matches.first()
        return DeviceCommandResult(
            commandId = command.id,
            status = DeviceCommandStatus.COMPLETED,
            result = mapOf(
                "count" to matches.size.toString(),
                "id" to first.id,
                "name" to first.displayName,
                "phone" to (first.phoneNumber ?: ""),
            ),
        )
    }
}
