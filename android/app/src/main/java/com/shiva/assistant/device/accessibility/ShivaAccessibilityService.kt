package com.shiva.assistant.device.accessibility

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import com.shiva.assistant.core.logging.ShivaLog
import com.shiva.assistant.device.automation.AccessibilityEngineHolder

/**
 * Explicitly user-enabled. Backs Diagnostics screen inspection: the service itself only tracks
 * which app is in front and hands its instance to [AccessibilityEngineHolder].
 */
class ShivaAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        super.onServiceConnected()
        AccessibilityEngineHolder.attach(this)
        ShivaLog.i(ShivaLog.CAPABILITIES, "Accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOWS_CHANGED,
            -> AccessibilityEngineHolder.recordForeground(
                packageName = event.packageName?.toString(),
                windowClass = event.className?.toString(),
                atEpochMs = System.currentTimeMillis(),
            )
        }
    }

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: Intent?): Boolean {
        AccessibilityEngineHolder.detach(this)
        ShivaLog.i(ShivaLog.CAPABILITIES, "Accessibility service unbound")
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        AccessibilityEngineHolder.detach(this)
        super.onDestroy()
    }
}
