package com.shiva.assistant.device.notifications

import android.content.Context
import androidx.core.app.NotificationManagerCompat

class AndroidNotificationsRepository(
    context: Context,
    private val store: NotificationStore,
) : NotificationsRepository {
    private val appContext = context.applicationContext

    override fun access(): NotificationsAccess {
        val enabled = NotificationManagerCompat.getEnabledListenerPackages(appContext)
        return if (enabled.contains(appContext.packageName)) {
            NotificationsAccess.Granted
        } else {
            NotificationsAccess.Denied
        }
    }

    override fun listActive(limit: Int, packageName: String?): List<NotificationSummary> {
        if (access() == NotificationsAccess.Denied) return emptyList()
        return store.list(limit = limit, packageFilter = packageName)
    }

    override fun readByKey(key: String): NotificationDetail? {
        if (access() == NotificationsAccess.Denied) return null
        return store.read(key)
    }
}
