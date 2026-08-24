package com.shiva.assistant.core.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

data class ShivaPalette(
    val isDark: Boolean,
    val background: Color,
    val surface: Color,
    val elevated: Color,
    val hairline: Color,
    val text: Color,
    val muted: Color,
    val dim: Color,
    val accent: Color,
    val accentSoft: Color,
    val positive: Color,
    val danger: Color,
    val userBubble: Color,
    val assistantBubble: Color,
    val code: Color,
)

val LocalShivaPalette = staticCompositionLocalOf {
    ShivaPalette(
        isDark = true,
        background = ShivaColors.Graphite,
        surface = ShivaColors.GraphiteRaised,
        elevated = ShivaColors.GraphiteElevated,
        hairline = ShivaColors.Hairline,
        text = ShivaColors.Cream,
        muted = ShivaColors.CreamMuted,
        dim = ShivaColors.CreamDim,
        accent = ShivaColors.Gold,
        accentSoft = ShivaColors.GoldSoft,
        positive = ShivaColors.Sage,
        danger = ShivaColors.Coral,
        userBubble = ShivaColors.UserBubble,
        assistantBubble = ShivaColors.AssistantBubble,
        code = ShivaColors.CodeSurface,
    )
}

private val DarkPalette = ShivaPalette(
    isDark = true,
    background = ShivaColors.Graphite,
    surface = ShivaColors.GraphiteRaised,
    elevated = ShivaColors.GraphiteElevated,
    hairline = ShivaColors.Hairline,
    text = ShivaColors.Cream,
    muted = ShivaColors.CreamMuted,
    dim = ShivaColors.CreamDim,
    accent = ShivaColors.Gold,
    accentSoft = ShivaColors.GoldSoft,
    positive = ShivaColors.Sage,
    danger = ShivaColors.Coral,
    userBubble = ShivaColors.UserBubble,
    assistantBubble = ShivaColors.AssistantBubble,
    code = ShivaColors.CodeSurface,
)

private val LightPalette = ShivaPalette(
    isDark = false,
    background = ShivaColors.LightBackground,
    surface = ShivaColors.LightSurface,
    elevated = Color(0xFFEFE6DA),
    hairline = Color(0x1A1A1714),
    text = ShivaColors.LightInk,
    muted = Color(0xFF6E675E),
    dim = Color(0xFF8A8278),
    accent = ShivaColors.GoldDeep,
    accentSoft = Color(0x33B8895A),
    positive = Color(0xFF3E8F6E),
    danger = Color(0xFFC45C4F),
    userBubble = Color(0xFFF0E4D4),
    assistantBubble = Color(0xFFEFE8DF),
    code = Color(0xFFE7DFD4),
)

@Composable
fun ShivaTheme(
    mode: ThemeMode = ThemeMode.DARK,
    content: @Composable () -> Unit,
) {
    val dark = when (mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
    }
    val palette = if (dark) DarkPalette else LightPalette
    val scheme = if (dark) {
        darkColorScheme(
            primary = palette.accent,
            onPrimary = ShivaColors.Graphite,
            background = palette.background,
            onBackground = palette.text,
            surface = palette.surface,
            onSurface = palette.text,
            surfaceVariant = palette.elevated,
            onSurfaceVariant = palette.muted,
            error = palette.danger,
            outline = palette.hairline,
        )
    } else {
        lightColorScheme(
            primary = palette.accent,
            onPrimary = Color.White,
            background = palette.background,
            onBackground = palette.text,
            surface = palette.surface,
            onSurface = palette.text,
            surfaceVariant = palette.elevated,
            onSurfaceVariant = palette.muted,
            error = palette.danger,
            outline = palette.hairline,
        )
    }
    CompositionLocalProvider(LocalShivaPalette provides palette) {
        MaterialTheme(
            colorScheme = scheme,
            typography = ShivaTypography,
            content = content,
        )
    }
}
