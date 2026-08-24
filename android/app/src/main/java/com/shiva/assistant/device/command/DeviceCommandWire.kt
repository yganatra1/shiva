package com.shiva.assistant.device.command

import com.shiva.assistant.core.network.ShivaJson
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@OptIn(ExperimentalSerializationApi::class)
@Serializable
internal data class DeviceCommandWireMessage(
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val type: String,
    val command: DeviceCommandWirePayload,
)

@Serializable
internal data class DeviceCommandWirePayload(
    val id: String,
    val type: String,
    val arguments: Map<String, String> = emptyMap(),
    val createdAtEpochMs: Long,
    val expiresAtEpochMs: Long? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
internal data class DeviceCommandResultWireMessage(
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val type: String = "device_command_result",
    val result: DeviceCommandResultWirePayload,
)

@Serializable
internal data class DeviceCommandResultWirePayload(
    val commandId: String,
    val status: String,
    val result: Map<String, String> = emptyMap(),
    val error: String? = null,
)

internal fun parseDeviceCommandMessage(body: String): DeviceCommand? {
    val wire = runCatching {
        ShivaJson.decodeFromString<DeviceCommandWireMessage>(body)
    }.getOrNull() ?: return null
    if (wire.type != "device_command") return null
    return DeviceCommand(
        id = wire.command.id,
        type = wire.command.type,
        arguments = wire.command.arguments,
        createdAtEpochMs = wire.command.createdAtEpochMs,
        expiresAtEpochMs = wire.command.expiresAtEpochMs,
    )
}

/** Maps internal statuses to the server-accepted wire enum (strict Zod schema on the API). */
internal fun deviceCommandStatusForWire(status: DeviceCommandStatus): String = when (status) {
    DeviceCommandStatus.COMPLETED -> "COMPLETED"
    DeviceCommandStatus.FAILED -> "FAILED"
    DeviceCommandStatus.DENIED -> "DENIED"
    DeviceCommandStatus.UNSUPPORTED -> "UNSUPPORTED"
    DeviceCommandStatus.EXPIRED -> "FAILED"
}

internal fun encodeDeviceCommandResult(result: DeviceCommandResult): String {
    val wireStatus = deviceCommandStatusForWire(result.status)
    val wireError = result.error
        ?: if (result.status == DeviceCommandStatus.EXPIRED) {
            "Command expired before execution."
        } else {
            null
        }
    return ShivaJson.encodeToString(
        DeviceCommandResultWireMessage(
            result = DeviceCommandResultWirePayload(
                commandId = result.commandId,
                status = wireStatus,
                result = result.result,
                error = wireError,
            ),
        ),
    )
}
