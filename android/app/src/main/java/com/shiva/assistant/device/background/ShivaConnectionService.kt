package com.shiva.assistant.device.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.shiva.assistant.MainActivity
import com.shiva.assistant.R
import com.shiva.assistant.ShivaApplication
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicReference

/**
 * Keeps Shiva's health monitor and device WebSocket alive while the UI is in
 * the background. Temporarily elevates to FOREGROUND_SERVICE_TYPE_CAMERA when
 * a remote capture command needs the camera without launching an Activity.
 */
class ShivaConnectionService : Service() {
    private var latestNotification: Notification? = null
    private var cameraTypeActive = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val container = (application as ShivaApplication).container
        val launch = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = buildNotification(
            title = getString(R.string.connection_service_title),
            text = getString(R.string.connection_service_starting),
            launch = launch,
        )
        latestNotification = notification
        val includeCamera = intent?.action == ACTION_CAMERA_CAPTURE
        startForegroundWithTypes(notification = notification, includeCamera = includeCamera)
        cameraTypeActive = includeCamera
        instance = this
        pendingPromote.getAndSet(null)?.complete(true)

        container.backgroundConnectionManager.onServiceStarted { title, text ->
            val manager = getSystemService(NotificationManager::class.java)
            val updated = buildNotification(title, text, launch)
            latestNotification = updated
            manager.notify(NOTIFICATION_ID, updated)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        pendingPromote.getAndSet(null)?.complete(false)
        (application as ShivaApplication).container.backgroundConnectionManager.onServiceStopped()
        super.onDestroy()
    }

    internal fun promoteForegroundServiceForCamera(): Boolean {
        val notification = latestNotification ?: return false
        return try {
            startForegroundWithTypes(notification = notification, includeCamera = true)
            cameraTypeActive = true
            true
        } catch (_: Exception) {
            false
        }
    }

    internal fun demoteCameraType() {
        if (!cameraTypeActive) return
        val notification = latestNotification ?: return
        try {
            startForegroundWithTypes(notification = notification, includeCamera = false)
            cameraTypeActive = false
        } catch (_: Exception) {
            // Keep camera type if demote fails; next restart clears it.
        }
    }

    private fun startForegroundWithTypes(notification: Notification, includeCamera: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            if (includeCamera && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
            startForeground(NOTIFICATION_ID, notification, types)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(
        title: String,
        text: String,
        launch: PendingIntent,
    ): Notification = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_shiva)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setContentIntent(launch)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .build()

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL,
                getString(R.string.connection_service_channel),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    companion object {
        private const val CHANNEL = "shiva_connection"
        private const val NOTIFICATION_ID = 1
        const val ACTION_CAMERA_CAPTURE = "com.shiva.assistant.action.CAMERA_CAPTURE"

        @Volatile
        private var instance: ShivaConnectionService? = null

        private val pendingPromote = AtomicReference<CompletableDeferred<Boolean>?>(null)

        suspend fun promoteForCameraCapture(context: Context): Boolean {
            val running = instance
            if (running != null) {
                return running.promoteForegroundServiceForCamera()
            }
            val deferred = CompletableDeferred<Boolean>()
            if (!pendingPromote.compareAndSet(null, deferred)) {
                return pendingPromote.get()?.await() == true
            }
            val intent = Intent(context, ShivaConnectionService::class.java).apply {
                action = ACTION_CAMERA_CAPTURE
            }
            ContextCompat.startForegroundService(context, intent)
            return withTimeoutOrNull(5_000) { deferred.await() } == true
        }

        fun demoteCameraCapture() {
            instance?.demoteCameraType()
        }
    }
}
