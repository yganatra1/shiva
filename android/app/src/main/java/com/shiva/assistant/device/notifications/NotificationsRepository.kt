package com.shiva.assistant.device.notifications

sealed interface NotificationsAccess {
    data object Granted : NotificationsAccess
    data object Denied : NotificationsAccess
}

interface NotificationsRepository {
    fun access(): NotificationsAccess
    fun listActive(limit: Int = 20, packageName: String? = null): List<NotificationSummary>
    fun readByKey(key: String): NotificationDetail?
}
