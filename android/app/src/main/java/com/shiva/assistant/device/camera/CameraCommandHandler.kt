package com.shiva.assistant.device.camera

import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus

class CameraCommandHandler(
    private val controller: CameraController,
) : DeviceCommandHandler {
    override val type: String = "device.camera.capture"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val facing = parseCameraFacing(command.arguments["facing"])
        val quality = parseCaptureQuality(command.arguments["quality"])
        return when (val outcome = controller.capture(facing = facing, quality = quality)) {
            is CameraCaptureResult.Success -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf(
                    "mime" to outcome.mimeType,
                    "width" to outcome.width.toString(),
                    "height" to outcome.height.toString(),
                    "encoding" to "base64",
                    "data" to outcome.base64Jpeg,
                ),
            )
            CameraCaptureResult.PermissionDenied -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.DENIED,
                error = "Camera permission is not granted.",
            )
            is CameraCaptureResult.Failed -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = outcome.reason,
            )
        }
    }
}
