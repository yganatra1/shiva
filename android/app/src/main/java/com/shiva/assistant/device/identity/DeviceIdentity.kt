package com.shiva.assistant.device.identity

data class DeviceIdentity(
    val deviceId: String,
    val deviceName: String,
    val platform: String = "android",
    val appVersion: String,
    val androidVersion: String,
    val deviceModel: String,
)

fun newInstallationId(): String {
    val uuid = java.util.UUID.randomUUID().toString().replace("-", "")
    return "android_" + uuid.take(16)
}
