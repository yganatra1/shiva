package com.shiva.assistant.core.connection

import com.shiva.assistant.core.logging.ShivaLog
import com.shiva.assistant.core.network.HealthResult
import com.shiva.assistant.core.network.ShivaClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class ConnectionMonitor(
    private val client: ShivaClient,
    private val urlProvider: () -> String?,
    private val scope: CoroutineScope,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _state = MutableStateFlow(ConnectionSnapshot())
    val state: StateFlow<ConnectionSnapshot> = _state.asStateFlow()
    private var loop: Job? = null

    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            while (isActive) {
                probe(silent = _state.value.status != ConnectionStatus.DISCONNECTED)
                delay(if (_state.value.isConnected) 20_000 else 8_000)
            }
        }
    }

    fun stop() {
        loop?.cancel()
        loop = null
    }

    suspend fun probe(silent: Boolean = false): HealthResult {
        if (!silent) {
            _state.update { it.copy(status = ConnectionStatus.CONNECTING, serverUrl = urlProvider()) }
        } else if (_state.value.status == ConnectionStatus.DISCONNECTED) {
            _state.update { it.copy(status = ConnectionStatus.CONNECTING, serverUrl = urlProvider()) }
        }
        ShivaLog.i(ShivaLog.CONNECTION, "Probing Shiva health")
        val result = client.health()
        _state.update { reduceConnection(it, urlProvider(), result, now()) }
        return result
    }
}
