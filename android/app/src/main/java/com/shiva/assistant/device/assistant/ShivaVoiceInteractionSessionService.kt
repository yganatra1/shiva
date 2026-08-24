package com.shiva.assistant.device.assistant

import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService

class ShivaVoiceInteractionSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession {
        return ShivaVoiceInteractionSession(this)
    }
}

private class ShivaVoiceInteractionSession(
    context: android.content.Context,
) : VoiceInteractionSession(context)
