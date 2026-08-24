package com.shiva.assistant.device.phone

import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus

class PhoneCommandHandler(
    private val controller: PhoneController,
) : DeviceCommandHandler {
    override val type: String = "device.phone.call"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val number = command.arguments["number"]
        if (number.isNullOrBlank()) {
            return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "Missing number argument.",
            )
        }
        val direct = command.arguments["direct"]?.toBooleanStrictOrNull() ?: false
        val outcome = if (direct) controller.call(number) else controller.dial(number)
        return when (outcome) {
            is PhoneResult.Started -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf(
                    "number" to outcome.number,
                    "direct" to outcome.direct.toString(),
                ),
            )
            is PhoneResult.Failed -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = outcome.reason,
            )
        }
    }
}
