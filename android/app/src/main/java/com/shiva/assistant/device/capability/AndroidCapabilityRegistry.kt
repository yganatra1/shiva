package com.shiva.assistant.device.capability

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.shiva.assistant.device.accessibility.ShivaAccessibilityService
import com.shiva.assistant.device.notifications.ShivaNotificationListenerService

class AndroidCapabilityRegistry(
    private val context: Context,
) {
    private val appContext = context.applicationContext
    private val roles = RoleSupport(appContext)

    val capabilities: List<DeviceCapability> = listOf(
        RuntimeCapability(
            id = CapabilityId.MICROPHONE,
            title = "Microphone",
            description = "Lets Shiva hear you for the coming voice interface. Audio is sent to your Shiva server, not a third-party cloud.",
            permissions = listOf(Manifest.permission.RECORD_AUDIO),
            feature = PackageManager.FEATURE_MICROPHONE,
        ),
        RuntimeCapability(
            id = CapabilityId.CONTACTS,
            title = "Contacts",
            description = "Lets Shiva find people when you say things like “Call Charmi” or “Message Abhishek.” Your contact database is not automatically uploaded.",
            permissions = listOf(Manifest.permission.READ_CONTACTS),
        ),
        RuntimeCapability(
            id = CapabilityId.PHONE_CALLS,
            title = "Phone calls",
            description = "Lets Shiva initiate a call when you ask. Direct calling needs this permission; otherwise Shiva can still open the dialer.",
            permissions = listOf(Manifest.permission.CALL_PHONE),
            feature = PackageManager.FEATURE_TELEPHONY,
        ),
        object : DeviceCapability {
            override val id = CapabilityId.NOTIFICATIONS
            override fun snapshot(): CapabilitySnapshot {
                val enabled = isNotificationListenerEnabled()
                return CapabilitySnapshot(
                    id = id,
                    title = "Notification access",
                    description = "Lets Shiva list and read active notifications when you ask. Requires notification access in Android settings.",
                    status = if (enabled) CapabilityStatus.ENABLED else CapabilityStatus.REQUIRES_SYSTEM_SETTING,
                    detail = if (enabled) "Notification listener is enabled." else "Android requires enabling Shiva in notification access.",
                )
            }

            override fun accessRequest() = AccessRequest.SystemSettings(
                action = Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS,
            )
        },
        RuntimeCapability(
            id = CapabilityId.LOCATION,
            title = "Location",
            description = "Lets Shiva read this phone’s location when you explicitly ask. Shiva does not track you in the background.",
            permissions = listOf(
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION,
            ),
            feature = PackageManager.FEATURE_LOCATION,
            requireAll = false,
        ),
        RuntimeCapability(
            id = CapabilityId.CAMERA,
            title = "Camera",
            description = "Prepared for a future capture skill. Shiva will only use the camera when you ask.",
            permissions = listOf(Manifest.permission.CAMERA),
            feature = PackageManager.FEATURE_CAMERA_ANY,
        ),
        RuntimeCapability(
            id = CapabilityId.FILES,
            title = "Files / media",
            description = "Prepared so Shiva can work with photos and files through modern Android storage APIs when you ask.",
            permissions = mediaPermissions(),
        ),
        object : DeviceCapability {
            override val id = CapabilityId.SMS
            override fun snapshot(): CapabilitySnapshot {
                val role = roles.sms()
                val status = when {
                    !role.supportedOnThisSdk || !role.available -> CapabilityStatus.REQUIRES_DEFAULT_APP_ROLE
                    role.held -> CapabilityStatus.AVAILABLE
                    else -> CapabilityStatus.REQUIRES_DEFAULT_APP_ROLE
                }
                return CapabilitySnapshot(
                    id = id,
                    title = "SMS",
                    description = "Prepared for sending or reading messages through official Android roles. Ordinary apps cannot silently become the SMS app.",
                    status = status,
                    detail = if (role.held) {
                        "This phone currently uses Shiva as the default SMS app."
                    } else {
                        "Android restricts SMS to the default SMS app. Shiva will not bypass that."
                    },
                )
            }

            override fun accessRequest() = AccessRequest.SystemSettings(
                action = Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS,
            )
        },
        RuntimeCapability(
            id = CapabilityId.CALL_INFO,
            title = "Call information",
            description = "Lets Shiva read basic call state when a future skill needs it. This is not call recording.",
            permissions = listOf(Manifest.permission.READ_PHONE_STATE),
            feature = PackageManager.FEATURE_TELEPHONY,
        ),
        object : DeviceCapability {
            override val id = CapabilityId.ACCESSIBILITY
            override fun snapshot(): CapabilitySnapshot {
                val enabled = isAccessibilityEnabled()
                return CapabilitySnapshot(
                    id = id,
                    title = "Accessibility",
                    description = "Powers on-screen automation: reading the current screen and tapping, typing, and scrolling in other apps. You must enable it yourself. Shiva does not use it to bypass Android security.",
                    status = if (enabled) CapabilityStatus.ENABLED else CapabilityStatus.REQUIRES_SYSTEM_SETTING,
                    detail = if (enabled) {
                        "Screen reading and UI automation are available. Use Diagnostics → Inspect current screen to see what Shiva can read."
                    } else {
                        "Enable Shiva in Android accessibility settings to allow screen reading and UI automation."
                    },
                )
            }

            override fun accessRequest() = AccessRequest.SystemSettings(
                action = Settings.ACTION_ACCESSIBILITY_SETTINGS,
            )
        },
        object : DeviceCapability {
            override val id = CapabilityId.DEFAULT_ASSISTANT
            override fun snapshot(): CapabilitySnapshot {
                val role = roles.assistant()
                val status = when {
                    !role.supportedOnThisSdk || !role.available -> CapabilityStatus.NOT_SUPPORTED
                    role.held -> CapabilityStatus.ENABLED
                    else -> CapabilityStatus.REQUIRES_DEFAULT_APP_ROLE
                }
                return CapabilitySnapshot(
                    id = id,
                    title = "Default assistant",
                    description = "Prepared so Shiva can become your selected Android assistant on compatible devices. Voice hotword is a later milestone.",
                    status = status,
                    detail = when (status) {
                        CapabilityStatus.ENABLED -> "Shiva currently holds the assistant role."
                        CapabilityStatus.NOT_SUPPORTED -> "This Android version or device does not expose an assistant role."
                        else -> "Choose Shiva in default digital assistant settings when you are ready."
                    },
                )
            }

            override fun accessRequest() = AccessRequest.SystemSettings(
                action = Settings.ACTION_VOICE_INPUT_SETTINGS,
            )
        },
        object : DeviceCapability {
            override val id = CapabilityId.BATTERY_OPTIMIZATION
            override fun snapshot(): CapabilitySnapshot {
                val power = appContext.getSystemService(PowerManager::class.java)
                val ignoring = power?.isIgnoringBatteryOptimizations(appContext.packageName) == true
                return CapabilitySnapshot(
                    id = id,
                    title = "Background operation",
                    description = "Helps Shiva stay reachable. V0.1 does not run an aggressive background loop; this prepares always-connected device mode.",
                    status = if (ignoring) CapabilityStatus.ENABLED else CapabilityStatus.REQUIRES_SYSTEM_SETTING,
                    detail = if (ignoring) {
                        "Battery optimization is ignored for Shiva."
                    } else {
                        "Android may pause background work unless you exempt Shiva."
                    },
                )
            }

            override fun accessRequest() = AccessRequest.SystemSettings(
                action = Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
            )
        },
    )

    fun snapshotAll(): List<CapabilitySnapshot> = capabilities.map { it.snapshot() }

    fun find(id: CapabilityId): DeviceCapability? = capabilities.firstOrNull { it.id == id }

    private inner class RuntimeCapability(
        override val id: CapabilityId,
        private val title: String,
        private val description: String,
        private val permissions: List<String>,
        private val feature: String? = null,
        private val requireAll: Boolean = true,
    ) : DeviceCapability {
        override fun snapshot(): CapabilitySnapshot {
            val supported = feature == null || appContext.packageManager.hasSystemFeature(feature)
            val granted = if (requireAll) {
                permissions.all { hasPermission(it) }
            } else {
                permissions.any { hasPermission(it) }
            }
            val status = mapRuntimePermission(granted = granted, supported = supported)
            return CapabilitySnapshot(
                id = id,
                title = title,
                description = description,
                status = status,
                detail = when (status) {
                    CapabilityStatus.AVAILABLE -> "Android has granted this permission."
                    CapabilityStatus.PERMISSION_REQUIRED -> "Shiva will ask Android for access when you enable it."
                    CapabilityStatus.NOT_SUPPORTED -> "This hardware is not present."
                    else -> status.label()
                },
            )
        }

        override fun accessRequest(): AccessRequest {
            val supported = feature == null || appContext.packageManager.hasSystemFeature(feature)
            if (!supported) return AccessRequest.Unavailable
            return AccessRequest.RuntimePermissions(permissions)
        }
    }

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(appContext, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun mediaPermissions(): List<String> {
        return when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> listOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_AUDIO,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
            )
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> listOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_AUDIO,
                Manifest.permission.READ_MEDIA_VIDEO,
            )
            else -> listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun isNotificationListenerEnabled(): Boolean {
        val enabled = NotificationManagerCompat.getEnabledListenerPackages(appContext)
        return enabled.contains(appContext.packageName) ||
            Settings.Secure.getString(
                appContext.contentResolver,
                "enabled_notification_listeners",
            )?.contains(ShivaNotificationListenerService::class.java.name) == true
    }

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getInt(
            appContext.contentResolver,
            Settings.Secure.ACCESSIBILITY_ENABLED,
            0,
        ) == 1
        if (!enabled) return false
        val services = Settings.Secure.getString(
            appContext.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        val component = "${appContext.packageName}/${ShivaAccessibilityService::class.java.name}"
        return services.split(':').any { it.equals(component, ignoreCase = true) }
    }

    companion object {
        fun settingsIntent(request: AccessRequest.SystemSettings, context: Context): Intent {
            return Intent(request.action).apply {
                if (request.dataUri != null) {
                    data = android.net.Uri.parse(request.dataUri)
                }
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
    }
}
