package com.shiva.assistant.device.notifications

import android.app.Notification
import android.service.notification.StatusBarNotification
import java.util.concurrent.ConcurrentHashMap

class NotificationStore {
    private val byKey = ConcurrentHashMap<String, StoredNotification>()

    fun upsert(statusBarNotification: StatusBarNotification) {
        val record = StoredNotification.from(statusBarNotification) ?: return
        byKey[record.detail.key] = record
    }

    fun remove(statusBarNotification: StatusBarNotification) {
        val record = StoredNotification.from(statusBarNotification) ?: return
        byKey.remove(record.detail.key)
    }

    fun replaceAll(notifications: Array<StatusBarNotification>) {
        byKey.clear()
        notifications.forEach { upsert(it) }
    }

    fun list(limit: Int, packageFilter: String?): List<NotificationSummary> {
        return byKey.values
            .sortedByDescending { it.detail.postTimeEpochMs }
            .asSequence()
            .filter { packageFilter.isNullOrBlank() || it.detail.packageName == packageFilter }
            .take(limit.coerceAtLeast(1))
            .map { it.summary() }
            .toList()
    }

    fun read(key: String): NotificationDetail? = byKey[key]?.detail
}

private data class StoredNotification(
    val detail: NotificationDetail,
) {
    fun summary(): NotificationSummary = NotificationSummary(
        key = detail.key,
        packageName = detail.packageName,
        title = detail.title,
        text = detail.text,
        postTimeEpochMs = detail.postTimeEpochMs,
    )

    companion object {
        fun from(statusBarNotification: StatusBarNotification): StoredNotification? {
            val notification = statusBarNotification.notification ?: return null
            val extras = notification.extras ?: return null
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            val postTime = statusBarNotification.postTime
            val key = notificationKey(
                packageName = statusBarNotification.packageName,
                tag = statusBarNotification.tag,
                id = statusBarNotification.id,
                postTimeEpochMs = postTime,
            )
            val actions = notification.actions
                ?.mapNotNull { action ->
                    action.title?.toString()?.takeIf { it.isNotBlank() }?.let {
                        NotificationActionSummary(title = it)
                    }
                }
                .orEmpty()
            return StoredNotification(
                detail = NotificationDetail(
                    key = key,
                    packageName = statusBarNotification.packageName,
                    title = title,
                    text = text,
                    bigText = bigText.ifBlank { text },
                    postTimeEpochMs = postTime,
                    category = notification.category,
                    actions = actions,
                ),
            )
        }
    }
}
