package com.shiva.assistant.device.location

import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus

class LocationCommandHandler(
    private val controller: LocationController,
) : DeviceCommandHandler {
    override val type: String = "device.location.get"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        return when (val outcome = controller.getLocation()) {
            is LocationResult.Found -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf(
                    "latitude" to outcome.latitude.toString(),
                    "longitude" to outcome.longitude.toString(),
                    "accuracyMeters" to outcome.accuracyMeters.toString(),
                    "ageMs" to outcome.ageMs.toString(),
                ),
            )
            is LocationResult.Failed -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = outcome.reason,
            )
        }
    }
}
