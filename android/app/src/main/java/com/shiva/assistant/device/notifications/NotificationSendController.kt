package com.shiva.assistant.device.notifications

sealed interface NotificationSendResult {
    data object Sent : NotificationSendResult
    data class Denied(val reason: String) : NotificationSendResult
    data class Failed(val reason: String) : NotificationSendResult
}

/**
 * Android 13+ requires POST_NOTIFICATIONS for Shiva-authored alerts.
 * Channel/app notification toggles can still suppress posting even when
 * that permission is granted, including on older API levels.
 */
internal fun notificationPostingBlockReason(
    sdkInt: Int,
    postNotificationsGranted: Boolean,
    notificationsEnabled: Boolean,
): String? {
    if (sdkInt >= 33 && !postNotificationsGranted) {
        return "Notification permission has not been granted."
    }
    if (!notificationsEnabled) {
        return "Notifications are disabled for Shiva."
    }
    return null
}

/** Posts a notification from Shiva itself, distinct from NotificationsRepository which reads notifications already on the phone. */
interface NotificationSendController {
    fun send(title: String, body: String): NotificationSendResult
}
