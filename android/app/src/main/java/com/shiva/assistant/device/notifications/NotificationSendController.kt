package com.shiva.assistant.device.notifications

sealed interface NotificationSendResult {
    data object Sent : NotificationSendResult
    data class Failed(val reason: String) : NotificationSendResult
}

/** Posts a notification from Shiva itself, distinct from NotificationsRepository which reads notifications already on the phone. */
interface NotificationSendController {
    fun send(title: String, body: String): NotificationSendResult
}
