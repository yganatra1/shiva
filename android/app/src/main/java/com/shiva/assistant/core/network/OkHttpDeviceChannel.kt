package com.shiva.assistant.core.network

import com.shiva.assistant.core.connection.ReconnectBackoff
import com.shiva.assistant.core.logging.ShivaLog
import com.shiva.assistant.core.security.DeviceTokenStore
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandRouter
import com.shiva.assistant.device.command.DeviceCommandStatus
import com.shiva.assistant.device.command.encodeDeviceCommandResult
import com.shiva.assistant.device.command.parseDeviceCommandMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Persistent device command WebSocket. The Shiva server does not expose `/device/ws`
 * yet; until it does, this stays in RETRYING while HTTP health checks remain the
 * live control plane.
 */
class OkHttpDeviceChannel(
    private val urlProvider: () -> String?,
    private val tokenStore: DeviceTokenStore,
    private val commandRouter: DeviceCommandRouter,
    private val scope: CoroutineScope,
    private val path: String = "/device/ws",
    private val client: OkHttpClient = defaultClient(),
) : DeviceChannel {

    private val _state = MutableStateFlow(DeviceChannelState.DISABLED)
    override val state: StateFlow<DeviceChannelState> = _state.asStateFlow()

    private var loopJob: Job? = null
    private var activeSocket: WebSocket? = null
    private val backoff = ReconnectBackoff()

    override fun connect() {
        if (loopJob?.isActive == true) return
        loopJob = scope.launch {
            while (isActive) {
                val wsUrl = resolveWebSocketUrl()
                if (wsUrl == null) {
                    _state.value = DeviceChannelState.DISABLED
                    delay(8_000)
                    continue
                }
                _state.value = DeviceChannelState.CONNECTING
                ShivaLog.i(ShivaLog.CONNECTION, "Opening device WebSocket")
                val closed = CompletableDeferred<Unit>()
                val request = Request.Builder()
                    .url(wsUrl)
                    .build()
                activeSocket = client.newWebSocket(
                    request,
                    object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            backoff.reset()
                            _state.value = DeviceChannelState.CONNECTED
                            ShivaLog.i(ShivaLog.CONNECTION, "Device WebSocket connected")
                        }

                        override fun onMessage(webSocket: WebSocket, text: String) {
                            val command = parseDeviceCommandMessage(text) ?: return
                            scope.launch(Dispatchers.Default) {
                                val result = try {
                                    commandRouter.dispatch(command)
                                } catch (error: Exception) {
                                    ShivaLog.w(
                                        ShivaLog.DEVICE,
                                        "Device command failed: ${error.javaClass.simpleName}",
                                    )
                                    DeviceCommandResult(
                                        commandId = command.id,
                                        status = DeviceCommandStatus.FAILED,
                                        error = error.message ?: "Command execution failed.",
                                    )
                                }
                                val payload = encodeDeviceCommandResult(result)
                                val sent = withContext(Dispatchers.IO) {
                                    webSocket.send(payload)
                                }
                                if (!sent) {
                                    ShivaLog.w(
                                        ShivaLog.DEVICE,
                                        "Device command result send failed (commandId=${result.commandId}, bytes=${payload.length})",
                                    )
                                }
                            }
                        }

                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                            webSocket.close(code, reason)
                        }

                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                            ShivaLog.i(ShivaLog.CONNECTION, "Device WebSocket closed")
                            if (!closed.isCompleted) closed.complete(Unit)
                        }

                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                            ShivaLog.w(
                                ShivaLog.CONNECTION,
                                "Device WebSocket failure: ${t.javaClass.simpleName}",
                            )
                            if (!closed.isCompleted) closed.complete(Unit)
                        }
                    },
                )
                closed.await()
                activeSocket = null
                _state.value = DeviceChannelState.RETRYING
                val waitMs = backoff.nextDelayMs()
                backoff.advance()
                delay(waitMs)
            }
        }
    }

    override fun disconnect() {
        loopJob?.cancel()
        loopJob = null
        activeSocket?.close(1000, "client disconnect")
        activeSocket = null
        _state.value = DeviceChannelState.DISABLED
    }

    private fun resolveWebSocketUrl(): String? {
        val raw = urlProvider() ?: return null
        return when (val parsed = ServerUrl.parse(raw)) {
            is ServerUrlParseResult.Valid ->
                deviceWebSocketUrl(parsed.url.origin(), path, tokenStore.token())
            is ServerUrlParseResult.Invalid -> null
        }
    }

    companion object {
        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
