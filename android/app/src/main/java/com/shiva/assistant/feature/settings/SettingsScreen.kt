package com.shiva.assistant.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.shiva.assistant.AppContainer
import com.shiva.assistant.BuildConfig
import com.shiva.assistant.core.design.LocalShivaPalette
import com.shiva.assistant.core.design.ShivaGhostButton
import com.shiva.assistant.core.design.ShivaPrimaryButton
import com.shiva.assistant.core.design.ShivaSurface
import com.shiva.assistant.core.design.ShivaTypography
import com.shiva.assistant.core.design.ThemeMode
import com.shiva.assistant.core.network.ServerUrl
import com.shiva.assistant.core.network.ServerUrlParseResult
import com.shiva.assistant.data.settings.AppSettings
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    container: AppContainer,
    settings: AppSettings,
    onOpenDiagnostics: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalShivaPalette.current
    val scope = rememberCoroutineScope()
    var serverUrl by remember { mutableStateOf(settings.persisted.serverUrl.orEmpty()) }
    var deviceName by remember { mutableStateOf(settings.identity.deviceName) }
    var urlError by remember { mutableStateOf<String?>(null) }
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(palette.background),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Text("Settings", style = ShivaTypography.headlineMedium, color = palette.text)
        }
        item {
            SectionTitle("Connection")
            ShivaSurface {
                Column {
                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Shiva Server URL") },
                        singleLine = true,
                        isError = urlError != null,
                        shape = RoundedCornerShape(16.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = palette.accent,
                            cursorColor = palette.accent,
                        ),
                    )
                    if (urlError != null) {
                        Text(urlError!!, color = palette.danger, style = ShivaTypography.bodySmall)
                    }
                    Spacer(Modifier.height(12.dp))
                    ShivaPrimaryButton(
                        text = "Save",
                        onClick = {
                            when (val parsed = ServerUrl.parse(serverUrl)) {
                                is ServerUrlParseResult.Valid -> {
                                    urlError = null
                                    container.rememberServerUrl(parsed.url.origin())
                                    scope.launch { container.settingsRepository.saveServerUrl(parsed.url.origin()) }
                                }
                                is ServerUrlParseResult.Invalid -> urlError = parsed.reason
                            }
                        },
                    )
                    Spacer(Modifier.height(16.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                "Keep connected in background",
                                style = ShivaTypography.titleMedium,
                                color = palette.text,
                            )
                            Text(
                                "Runs a low-priority foreground service, keeps health checks alive, and retries the device WebSocket if it drops.",
                                style = ShivaTypography.bodySmall,
                                color = palette.muted,
                            )
                        }
                        Switch(
                            checked = settings.persisted.keepAliveInBackground,
                            onCheckedChange = { enabled ->
                                scope.launch {
                                    container.settingsRepository.setKeepAliveInBackground(enabled)
                                }
                            },
                        )
                    }
                }
            }
        }
        item {
            SectionTitle("Device")
            ShivaSurface {
                Column {
                    OutlinedTextField(
                        value = deviceName,
                        onValueChange = { deviceName = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Device name") },
                        singleLine = true,
                        shape = RoundedCornerShape(16.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = palette.accent,
                            cursorColor = palette.accent,
                        ),
                    )
                    Spacer(Modifier.height(8.dp))
                    MetaRow("Device ID", settings.identity.deviceId)
                    Spacer(Modifier.height(12.dp))
                    ShivaPrimaryButton(
                        text = "Save name",
                        onClick = {
                            scope.launch { container.settingsRepository.saveDeviceName(deviceName.trim()) }
                        },
                    )
                }
            }
        }
        item {
            SectionTitle("Appearance")
            ShivaSurface {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ThemeMode.entries.forEach { mode ->
                        FilterChip(
                            selected = settings.persisted.themeMode == mode,
                            onClick = { scope.launch { container.settingsRepository.saveTheme(mode) } },
                            label = { Text(mode.name.lowercase().replaceFirstChar { it.titlecase() }) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = palette.accentSoft,
                                selectedLabelColor = palette.accent,
                            ),
                        )
                    }
                }
            }
        }
        item {
            SectionTitle("About")
            ShivaSurface {
                Column {
                    MetaRow("App version", BuildConfig.VERSION_NAME)
                    MetaRow("Build", BuildConfig.VERSION_CODE.toString())
                    Spacer(Modifier.height(8.dp))
                    ShivaGhostButton(text = "Diagnostics", onClick = onOpenDiagnostics)
                }
            }
        }
    }
}

@Composable
internal fun SectionTitle(text: String) {
    val palette = LocalShivaPalette.current
    Text(
        text = text,
        style = ShivaTypography.labelSmall,
        color = palette.accent,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
internal fun MetaRow(label: String, value: String) {
    val palette = LocalShivaPalette.current
    Column(modifier = Modifier.padding(vertical = 4.dp)) {
        Text(label, style = ShivaTypography.labelSmall, color = palette.dim)
        Text(value, style = ShivaTypography.bodyMedium, color = palette.text)
    }
}
