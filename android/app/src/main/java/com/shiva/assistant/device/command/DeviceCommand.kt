package com.shiva.assistant.device.command

data class DeviceCommand(
    val id: String,
    val type: String,
    val arguments: Map<String, String> = emptyMap(),
    val createdAtEpochMs: Long,
    val expiresAtEpochMs: Long? = null,
)

data class DeviceCommandResult(
    val commandId: String,
    val status: DeviceCommandStatus,
    val result: Map<String, String> = emptyMap(),
    val error: String? = null,
)

enum class DeviceCommandStatus {
    COMPLETED,
    FAILED,
    DENIED,
    UNSUPPORTED,
    EXPIRED,
}

interface DeviceCommandHandler {
    val type: String
    suspend fun handle(command: DeviceCommand): DeviceCommandResult
}

fun interface DeviceCommandObserver {
    fun onCommandHandled(command: DeviceCommand, result: DeviceCommandResult, durationMs: Long)
}

class DeviceCommandRouter(
    handlers: List<DeviceCommandHandler>,
    private val observer: DeviceCommandObserver? = null,
) {
    private val byType = handlers.associateBy { it.type }

    val supportedTypes: Set<String> get() = byType.keys

    suspend fun dispatch(command: DeviceCommand, nowMs: Long = System.currentTimeMillis()): DeviceCommandResult {
        val startedAtNanos = System.nanoTime()
        val result = execute(command, nowMs)
        observer?.onCommandHandled(
            command = command,
            result = result,
            durationMs = (System.nanoTime() - startedAtNanos) / 1_000_000,
        )
        return result
    }

    private suspend fun execute(command: DeviceCommand, nowMs: Long): DeviceCommandResult {
        if (command.expiresAtEpochMs != null && nowMs > command.expiresAtEpochMs) {
            return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.EXPIRED,
                error = "Command expired before execution.",
            )
        }
        val handler = byType[command.type]
            ?: return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.UNSUPPORTED,
                error = "No handler registered for ${command.type}.",
            )
        return handler.handle(command)
    }
}
