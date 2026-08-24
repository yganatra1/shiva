package com.shiva.assistant.core.design

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

object ShivaColors {
    val Graphite = Color(0xFF0C0D0F)
    val GraphiteRaised = Color(0xFF16181C)
    val GraphiteElevated = Color(0xFF1E2127)
    val Hairline = Color(0x14F2EDE6)
    val Cream = Color(0xFFF2EDE6)
    val CreamMuted = Color(0xFF9A948A)
    val CreamDim = Color(0xFF6F6A63)
    val Gold = Color(0xFFD4A574)
    val GoldDeep = Color(0xFFB8895A)
    val GoldSoft = Color(0x33D4A574)
    val Sage = Color(0xFF7CB89A)
    val SageSoft = Color(0x227CB89A)
    val Coral = Color(0xFFE07A6A)
    val CoralSoft = Color(0x22E07A6A)
    val UserBubble = Color(0xFF2A241C)
    val AssistantBubble = Color(0xFF181A1F)
    val CodeSurface = Color(0xFF101216)
    val LightBackground = Color(0xFFF6F1EA)
    val LightSurface = Color(0xFFFFFBF6)
    val LightInk = Color(0xFF1A1714)

    val Ambient = Brush.verticalGradient(
        colors = listOf(Color(0xFF14110E), Graphite, Color(0xFF0B0C0E)),
    )
}
