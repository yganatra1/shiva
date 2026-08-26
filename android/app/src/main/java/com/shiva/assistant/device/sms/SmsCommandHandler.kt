package com.shiva.assistant.device.sms

import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus

class SmsCommandHandler(
    private val controller: SmsController,
) : DeviceCommandHandler {
    override val type: String = "device.sms.send"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val number = command.arguments["number"]
        val message = command.arguments["message"]
        if (number.isNullOrBlank() || message.isNullOrBlank()) {
            return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "Missing number or message argument.",
            )
        }
        return when (val outcome = controller.send(number, message)) {
            is SmsResult.Sent -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf("number" to outcome.number),
            )
            is SmsResult.Failed -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = outcome.reason,
            )
        }
    }
}
