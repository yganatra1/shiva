package com.shiva.assistant.device.automation

import com.shiva.assistant.core.network.ShivaJson
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus
import kotlinx.serialization.encodeToString

/**
 * Single place where automation outcomes become device command results, so every device.ui.*
 * handler reports failures with the same status vocabulary.
 */
internal fun <T> UiOutcome<T>.toDeviceResult(
    commandId: String,
    success: (T) -> Map<String, String>,
): DeviceCommandResult = when (this) {
    is UiOutcome.Success -> DeviceCommandResult(
        commandId = commandId,
        status = DeviceCommandStatus.COMPLETED,
        result = success(value),
    )
    UiOutcome.ServiceUnavailable -> DeviceCommandResult(
        commandId = commandId,
        status = DeviceCommandStatus.DENIED,
        error = "Shiva's accessibility service is not enabled. Turn it on in Device Access.",
    )
    is UiOutcome.NotFound -> DeviceCommandResult(
        commandId = commandId,
        status = DeviceCommandStatus.FAILED,
        error = detail,
    )
    is UiOutcome.Failed -> DeviceCommandResult(
        commandId = commandId,
        status = DeviceCommandStatus.FAILED,
        error = reason,
    )
    is UiOutcome.Unsupported -> DeviceCommandResult(
        commandId = commandId,
        status = DeviceCommandStatus.UNSUPPORTED,
        error = reason,
    )
}

internal fun UiActionInfo.toResultMap(): Map<String, String> = buildMap {
    put("action", action)
    put("strategy", strategy)
    node?.let { put("node", ShivaJson.encodeToString(it)) }
}
