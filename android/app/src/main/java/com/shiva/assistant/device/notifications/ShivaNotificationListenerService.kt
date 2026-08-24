package com.shiva.assistant.device.notifications

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.shiva.assistant.ShivaApplication
import com.shiva.assistant.core.logging.ShivaLog

class ShivaNotificationListenerService : NotificationListenerService() {
    private val store
        get() = (application as ShivaApplication).container.notificationStore

    override fun onListenerConnected() {
        super.onListenerConnected()
        store.replaceAll(activeNotifications ?: emptyArray())
        ShivaLog.i(ShivaLog.CAPABILITIES, "Notification listener connected")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        store.upsert(sbn)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        if (sbn == null) return
        store.remove(sbn)
    }
}
