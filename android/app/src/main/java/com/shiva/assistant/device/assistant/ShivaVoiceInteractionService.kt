package com.shiva.assistant.device.assistant

import android.service.voice.VoiceInteractionService
import com.shiva.assistant.core.logging.ShivaLog

/**
 * Manifest-level assistant scaffolding. Hotword and voice sessions are a later milestone.
 */
class ShivaVoiceInteractionService : VoiceInteractionService() {
    override fun onReady() {
        super.onReady()
        ShivaLog.i(ShivaLog.CAPABILITIES, "Voice interaction service ready")
    }
}
