package com.shiva.assistant.feature.root

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.PhoneIphone
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import com.shiva.assistant.AppContainer
import com.shiva.assistant.core.design.LocalShivaPalette
import com.shiva.assistant.data.settings.AppSettings
import com.shiva.assistant.feature.capabilities.CapabilitiesScreen
import com.shiva.assistant.feature.chat.ChatScreen
import com.shiva.assistant.feature.diagnostics.DiagnosticsScreen
import com.shiva.assistant.feature.onboarding.OnboardingScreen
import com.shiva.assistant.feature.settings.SettingsScreen

private enum class MainTab(
    val label: String,
    val icon: ImageVector,
) {
    Chat("Chat", Icons.Outlined.ChatBubbleOutline),
    Device("Device", Icons.Outlined.PhoneIphone),
    Settings("Settings", Icons.Outlined.Settings),
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ShivaRoot(
    container: AppContainer,
    settings: AppSettings,
) {
    var onboarding by rememberSaveable {
        mutableStateOf(!settings.persisted.onboardingComplete || settings.persisted.serverUrl.isNullOrBlank())
    }
    var showDiagnostics by rememberSaveable { mutableStateOf(false) }
    if (onboarding) {
        OnboardingScreen(
            container = container,
            settings = settings,
            onFinished = { onboarding = false },
        )
        return
    }
    if (showDiagnostics) {
        DiagnosticsScreen(
            container = container,
            settings = settings,
            onBack = { showDiagnostics = false },
        )
        return
    }
    var tab by rememberSaveable { mutableStateOf(MainTab.Chat) }
    val palette = LocalShivaPalette.current
    // Keep the composer flush with the keyboard — the tab bar was creating a
    // large empty band between the text field and the IME.
    val hideBottomBar = tab == MainTab.Chat && WindowInsets.isImeVisible
    Scaffold(
        containerColor = palette.background,
        // adjustResize already shrinks the window for the keyboard; applying IME
        // insets again leaves a blank band above the keyboard.
        contentWindowInsets = WindowInsets.safeDrawing.exclude(WindowInsets.ime),
        bottomBar = {
            if (!hideBottomBar) {
                NavigationBar(containerColor = palette.surface) {
                    MainTab.entries.forEach { item ->
                        NavigationBarItem(
                            selected = tab == item,
                            onClick = { tab = item },
                            icon = { Icon(item.icon, contentDescription = item.label) },
                            label = { Text(item.label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = palette.accent,
                                selectedTextColor = palette.accent,
                                indicatorColor = palette.accentSoft,
                                unselectedIconColor = palette.muted,
                                unselectedTextColor = palette.muted,
                            ),
                        )
                    }
                }
            }
        },
    ) { padding ->
        when (tab) {
            MainTab.Chat -> ChatScreen(
                container = container,
                settings = settings,
                modifier = Modifier.padding(padding),
            )
            MainTab.Device -> CapabilitiesScreen(
                container = container,
                modifier = Modifier.padding(padding),
            )
            MainTab.Settings -> SettingsScreen(
                container = container,
                settings = settings,
                onOpenDiagnostics = { showDiagnostics = true },
                modifier = Modifier.padding(padding),
            )
        }
    }
}
