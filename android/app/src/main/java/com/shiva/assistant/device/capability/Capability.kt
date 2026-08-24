package com.shiva.assistant.device.capability

enum class CapabilityId {
    MICROPHONE,
    CONTACTS,
    PHONE_CALLS,
    NOTIFICATIONS,
    LOCATION,
    CAMERA,
    FILES,
    SMS,
    CALL_INFO,
    ACCESSIBILITY,
    DEFAULT_ASSISTANT,
    BATTERY_OPTIMIZATION,
}

enum class CapabilityStatus {
    AVAILABLE,
    PERMISSION_REQUIRED,
    ENABLED,
    DISABLED,
    NOT_SUPPORTED,
    REQUIRES_SYSTEM_SETTING,
    REQUIRES_DEFAULT_APP_ROLE,
    FUTURE,
}

data class CapabilitySnapshot(
    val id: CapabilityId,
    val title: String,
    val description: String,
    val status: CapabilityStatus,
    val detail: String,
)

sealed interface AccessRequest {
    data class RuntimePermissions(val permissions: List<String>) : AccessRequest
    data class SystemSettings(val action: String, val dataUri: String? = null) : AccessRequest
    data class AppDetailsSettings(val unused: Boolean = true) : AccessRequest
    data object Unavailable : AccessRequest
}

interface DeviceCapability {
    val id: CapabilityId
    fun snapshot(): CapabilitySnapshot
    fun accessRequest(): AccessRequest
}

fun CapabilityStatus.label(): String = when (this) {
    CapabilityStatus.AVAILABLE -> "Available"
    CapabilityStatus.PERMISSION_REQUIRED -> "Permission required"
    CapabilityStatus.ENABLED -> "Enabled"
    CapabilityStatus.DISABLED -> "Disabled"
    CapabilityStatus.NOT_SUPPORTED -> "Not supported on this device"
    CapabilityStatus.REQUIRES_SYSTEM_SETTING -> "Requires a system setting"
    CapabilityStatus.REQUIRES_DEFAULT_APP_ROLE -> "Requires a default app role"
    CapabilityStatus.FUTURE -> "Future"
}

fun mapRuntimePermission(granted: Boolean, supported: Boolean = true): CapabilityStatus {
    if (!supported) return CapabilityStatus.NOT_SUPPORTED
    return if (granted) CapabilityStatus.AVAILABLE else CapabilityStatus.PERMISSION_REQUIRED
}
