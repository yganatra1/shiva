package com.shiva.assistant.device.automation

import com.shiva.assistant.device.accessibility.ShivaAccessibilityService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.concurrent.atomic.AtomicReference

data class AccessibilityEngineState(
    val connected: Boolean = false,
    val foregroundPackage: String? = null,
    val foregroundWindowClass: String? = null,
    val lastEventAtEpochMs: Long? = null,
)

/**
 * Android starts [ShivaAccessibilityService], so the rest of the app cannot construct or inject
 * it. The service publishes itself here on connect and clears itself on unbind, which gives
 * command handlers a safe way to reach the live instance.
 */
object AccessibilityEngineHolder {
    private val serviceRef = AtomicReference<ShivaAccessibilityService?>(null)
    private val _state = MutableStateFlow(AccessibilityEngineState())
    val state: StateFlow<AccessibilityEngineState> = _state.asStateFlow()

    fun attach(service: ShivaAccessibilityService) {
        serviceRef.set(service)
        _state.update { it.copy(connected = true) }
    }

    fun detach(service: ShivaAccessibilityService) {
        if (serviceRef.compareAndSet(service, null)) {
            _state.update {
                it.copy(connected = false, foregroundPackage = null, foregroundWindowClass = null)
            }
        }
    }

    fun current(): ShivaAccessibilityService? = serviceRef.get()

    fun isConnected(): Boolean = serviceRef.get() != null

    fun recordForeground(packageName: String?, windowClass: String?, atEpochMs: Long) {
        _state.update {
            it.copy(
                foregroundPackage = packageName ?: it.foregroundPackage,
                foregroundWindowClass = windowClass ?: it.foregroundWindowClass,
                lastEventAtEpochMs = atEpochMs,
            )
        }
    }
}
