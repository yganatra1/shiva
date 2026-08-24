package com.shiva.assistant.core.connection

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.shiva.assistant.core.logging.ShivaLog
import com.shiva.assistant.core.network.DeviceChannel
import com.shiva.assistant.core.network.DeviceChannelState
import com.shiva.assistant.core.storage.PersistedSettings
import com.shiva.assistant.device.background.ShivaConnectionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class BackgroundConnectionManager(
    private val context: Context,
    private val connectionMonitor: ConnectionMonitor,
    private val deviceChannel: DeviceChannel,
    private val scope: CoroutineScope,
) {
    private var notificationJob: Job? = null
    private var notificationSink: ((String, String) -> Unit)? = null
    private var serviceRunning = false

    fun syncFromSettings(settings: PersistedSettings) {
        val shouldRun = settings.onboardingComplete &&
            !settings.serverUrl.isNullOrBlank() &&
            settings.keepAliveInBackground
        if (shouldRun) {
            start()
        } else {
            stop()
        }
    }

    fun start() {
        connectionMonitor.start()
        deviceChannel.connect()
        val intent = Intent(context, ShivaConnectionService::class.java)
        ContextCompat.startForegroundService(context, intent)
        ShivaLog.i(ShivaLog.CONNECTION, "Background keep-alive requested")
    }

    fun stop() {
        deviceChannel.disconnect()
        context.stopService(Intent(context, ShivaConnectionService::class.java))
        ShivaLog.i(ShivaLog.CONNECTION, "Background keep-alive stopped")
    }

    fun onServiceStarted(updateNotification: (String, String) -> Unit) {
        serviceRunning = true
        notificationSink = updateNotification
        notificationJob?.cancel()
        notificationJob = scope.launch {
            combine(connectionMonitor.state, deviceChannel.state) { connection, channel ->
                notificationCopy(connection, channel)
            }.collect { copy ->
                notificationSink?.invoke(copy.first, copy.second)
            }
        }
        scope.launch {
            connectionMonitor.probe(silent = true)
        }
    }

    fun onServiceStopped() {
        serviceRunning = false
        notificationJob?.cancel()
        notificationJob = null
        notificationSink = null
    }

    fun isServiceRunning(): Boolean = serviceRunning

    internal fun notificationCopy(
        connection: ConnectionSnapshot,
        channel: DeviceChannelState,
    ): Pair<String, String> {
        val title = when {
            connection.isConnected && channel == DeviceChannelState.CONNECTED ->
                "Shiva connected"
            connection.isConnected -> "Shiva reachable"
            connection.isConnecting -> "Connecting to Shiva"
            else -> "Reconnecting to Shiva"
        }
        val latency = connection.latencyMs?.let { "$it ms" } ?: "—"
        val channelLabel = when (channel) {
            DeviceChannelState.CONNECTED -> "device channel live"
            DeviceChannelState.CONNECTING -> "opening device channel"
            DeviceChannelState.RETRYING -> "device channel retrying"
            DeviceChannelState.DISABLED -> "device channel idle"
        }
        val text = buildString {
            append(connection.serverUrl ?: "Server not configured")
            append(" · ")
            append(connection.label())
            append(" · ")
            append(latency)
            append(" · ")
            append(channelLabel)
        }
        return title to text
    }
}
