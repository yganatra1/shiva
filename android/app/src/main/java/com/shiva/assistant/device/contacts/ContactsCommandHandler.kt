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
        // Report every candidate (up to a cap), not just the first — a common
        // name can match several contacts, and the planner needs to see them
        // all to ask the user instead of guessing.
        val result = buildMap {
            put("count", matches.size.toString())
            matches.take(MAX_REPORTED_MATCHES).forEachIndexed { index, match ->
                val n = index + 1
                put("id_$n", match.id)
                put("name_$n", match.displayName)
                put("phone_$n", match.phoneNumber ?: "")
            }
        }
        return DeviceCommandResult(
            commandId = command.id,
            status = DeviceCommandStatus.COMPLETED,
            result = result,
        )
    }

    private companion object {
        const val MAX_REPORTED_MATCHES = 5
    }
}
