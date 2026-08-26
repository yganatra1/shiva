package com.shiva.assistant.device.status

import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus

class DeviceStatusCommandHandler(
    private val controller: DeviceStatusController,
) : DeviceCommandHandler {
    override val type: String = "device.status.get"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        return when (val outcome = controller.getStatus()) {
            is DeviceStatusResult.Found -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf(
                    "batteryPercent" to outcome.batteryPercent.toString(),
                    "charging" to outcome.charging.toString(),
                    "networkType" to outcome.networkType,
                    "connected" to outcome.connected.toString(),
                ),
            )
            is DeviceStatusResult.Failed -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = outcome.reason,
            )
        }
    }
}
