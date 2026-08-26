package com.shiva.assistant.device.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.shiva.assistant.MainActivity
import com.shiva.assistant.R
import java.util.concurrent.atomic.AtomicInteger

class AndroidNotificationSendController(
    context: Context,
) : NotificationSendController {
    private val appContext = context.applicationContext

    override fun send(title: String, body: String): NotificationSendResult {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return NotificationSendResult.Failed("Notification permission has not been granted.")
        }
        val manager = appContext.getSystemService(NotificationManager::class.java)
            ?: return NotificationSendResult.Failed("Notifications are not available on this device.")
        ensureChannel(manager)
        val launch = PendingIntent.getActivity(
            appContext,
            0,
            Intent(appContext, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(appContext, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_shiva)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(launch)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        return try {
            manager.notify(idCounter.incrementAndGet(), notification)
            NotificationSendResult.Sent
        } catch (error: Exception) {
            NotificationSendResult.Failed("Android could not post the notification.")
        }
    }

    private fun ensureChannel(manager: NotificationManager) {
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Shiva alerts", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    companion object {
        private const val CHANNEL = "shiva_alerts"
        private val idCounter = AtomicInteger(1000)
    }
}
