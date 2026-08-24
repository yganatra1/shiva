package com.shiva.assistant.device.command

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class DeviceCommandRecord(
    val commandId: String,
    val type: String,
    val status: DeviceCommandStatus,
    val error: String? = null,
    val durationMs: Long = 0,
    val atEpochMs: Long = 0,
)

data class DeviceActivitySnapshot(
    val handled: Int = 0,
    val recent: List<DeviceCommandRecord> = emptyList(),
) {
    val last: DeviceCommandRecord? get() = recent.firstOrNull()
}

/**
 * Rolling in-memory record of device commands, surfaced on the diagnostics screen so it is
 * possible to see what the server asked the phone to do without reading logcat.
 */
class DeviceActivityLog(
    private val capacity: Int = 15,
    private val clock: () -> Long = System::currentTimeMillis,
) : DeviceCommandObserver {

    private val _state = MutableStateFlow(DeviceActivitySnapshot())
    val state: StateFlow<DeviceActivitySnapshot> = _state.asStateFlow()

    override fun onCommandHandled(
        command: DeviceCommand,
        result: DeviceCommandResult,
        durationMs: Long,
    ) {
        val record = DeviceCommandRecord(
            commandId = command.id,
            type = command.type,
            status = result.status,
            error = result.error,
            durationMs = durationMs,
            atEpochMs = clock(),
        )
        _state.update { current ->
            DeviceActivitySnapshot(
                handled = current.handled + 1,
                recent = (listOf(record) + current.recent).take(capacity),
            )
        }
    }

    fun clear() {
        _state.value = DeviceActivitySnapshot()
    }
}
