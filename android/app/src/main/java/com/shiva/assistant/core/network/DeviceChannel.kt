package com.shiva.assistant.core.network

/**
 * Persistent device command channel. Chat stays on HTTP until the Shiva server
 * exposes a dedicated device WebSocket. This abstraction is ready for that path.
 */
interface DeviceChannel {
    val state: kotlinx.coroutines.flow.StateFlow<DeviceChannelState>
    fun connect()
    fun disconnect()
}

enum class DeviceChannelState {
    DISABLED,
    CONNECTING,
    CONNECTED,
    RETRYING,
}

class HttpOnlyDeviceChannel : DeviceChannel {
    override val state = kotlinx.coroutines.flow.MutableStateFlow(DeviceChannelState.DISABLED)
    override fun connect() = Unit
    override fun disconnect() = Unit
}
