package com.shiva.assistant.device.status

sealed interface DeviceStatusResult {
    data class Found(
        val batteryPercent: Int,
        val charging: Boolean,
        val networkType: String,
        val connected: Boolean,
    ) : DeviceStatusResult
    data class Failed(val reason: String) : DeviceStatusResult
}

interface DeviceStatusController {
    fun getStatus(): DeviceStatusResult
}
