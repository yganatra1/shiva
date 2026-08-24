package com.shiva.assistant

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.shiva.assistant.core.design.ShivaTheme
import com.shiva.assistant.feature.root.ShivaRoot

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as ShivaApplication).container
        setContent {
            val settings by container.settingsRepository.settings.collectAsStateWithLifecycle(
                initialValue = null,
            )
            ShivaTheme(mode = settings?.persisted?.themeMode ?: com.shiva.assistant.core.design.ThemeMode.DARK) {
                if (settings != null) {
                    ShivaRoot(container = container, settings = settings!!)
                }
            }
        }
    }
}
