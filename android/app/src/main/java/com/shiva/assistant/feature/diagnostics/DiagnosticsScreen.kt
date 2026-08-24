package com.shiva.assistant.feature.diagnostics

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.shiva.assistant.AppContainer
import com.shiva.assistant.BuildConfig
import com.shiva.assistant.core.design.LocalShivaPalette
import com.shiva.assistant.core.design.ShivaGhostButton
import com.shiva.assistant.core.design.ShivaPrimaryButton
import com.shiva.assistant.core.design.ShivaSurface
import com.shiva.assistant.core.design.ShivaTypography
import com.shiva.assistant.data.settings.AppSettings
import com.shiva.assistant.device.automation.AccessibilityEngineHolder
import com.shiva.assistant.device.automation.UiOutcome
import com.shiva.assistant.device.automation.UiScreen
import com.shiva.assistant.device.capability.label
import com.shiva.assistant.device.command.DeviceCommandRecord
import com.shiva.assistant.device.phone.PhoneResult
import com.shiva.assistant.feature.settings.MetaRow
import com.shiva.assistant.feature.settings.SectionTitle
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun DiagnosticsScreen(
    container: AppContainer,
    settings: AppSettings,
    onBack: () -> Unit,
) {
    val palette = LocalShivaPalette.current
    val connection by container.connectionMonitor.state.collectAsStateWithLifecycle()
    val deviceChannel by container.deviceChannel.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var probing by remember { mutableStateOf(false) }
    var dialNumber by remember { mutableStateOf("") }
    var dialMessage by remember { mutableStateOf<String?>(null) }
    val capabilities = remember { container.capabilities.snapshotAll() }
    val engineState by AccessibilityEngineHolder.state.collectAsStateWithLifecycle()
    val deviceActivity by container.deviceActivityLog.state.collectAsStateWithLifecycle()
    var inspecting by remember { mutableStateOf(false) }
    var inspectOutput by remember { mutableStateOf<String?>(null) }
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.background)
            .statusBarsPadding(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            ShivaGhostButton(text = "Back", onClick = onBack)
            Text("Diagnostics", style = ShivaTypography.headlineMedium, color = palette.text)
        }
        item {
            SectionTitle("App")
            ShivaSurface {
                Column {
                    MetaRow("App version", BuildConfig.VERSION_NAME)
                    MetaRow("Build type", BuildConfig.BUILD_TYPE)
                    MetaRow("Device ID", settings.identity.deviceId)
                    MetaRow("Device name", settings.identity.deviceName)
                    MetaRow("Android", settings.identity.androidVersion)
                    MetaRow("Model", settings.identity.deviceModel)
                }
            }
        }
        item {
            SectionTitle("Server")
            ShivaSurface {
                Column {
                    MetaRow("Server URL", connection.serverUrl ?: settings.persisted.serverUrl ?: "Not set")
                    MetaRow("Connection", connection.label())
                    MetaRow("Reachable", if (connection.isConnected) "Yes" else "No")
                    MetaRow("Latency", connection.latencyMs?.let { "$it ms" } ?: "—")
                    MetaRow("Health", connection.serverVersion ?: "—")
                    MetaRow("Model", connection.model ?: "—")
                    MetaRow(
                        "Last success",
                        connection.lastSuccessfulAtEpochMs?.let { formatInstant(it) } ?: "Never",
                    )
                    MetaRow("Last error", connection.lastError ?: "None")
                    MetaRow(
                        "Background keep-alive",
                        if (settings.persisted.keepAliveInBackground) {
                            if (container.backgroundConnectionManager.isServiceRunning()) "Running" else "Starting"
                        } else {
                            "Off"
                        },
                    )
                    MetaRow("Device WebSocket", deviceChannel.name.lowercase().replaceFirstChar { it.titlecase() })
                    Spacer(Modifier.height(12.dp))
                    ShivaPrimaryButton(
                        text = "Test connection",
                        loading = probing,
                        onClick = {
                            probing = true
                            scope.launch {
                                val result = container.connectionMonitor.probe(silent = false)
                                if (result.reachable) {
                                    container.settingsRepository.recordSuccessfulConnection(System.currentTimeMillis())
                                }
                                probing = false
                            }
                        },
                    )
                }
            }
        }
        item {
            SectionTitle("Capabilities")
            ShivaSurface {
                Column {
                    capabilities.forEach { snapshot ->
                        MetaRow(snapshot.title, snapshot.status.label())
                    }
                }
            }
        }
        item {
            SectionTitle("Live device status")
            ShivaSurface {
                Column {
                    MetaRow(
                        "Accessibility engine",
                        if (engineState.connected) "Active" else "Not enabled",
                    )
                    MetaRow("Foreground app", engineState.foregroundPackage ?: "—")
                    MetaRow("Foreground screen", engineState.foregroundWindowClass?.substringAfterLast('.') ?: "—")
                    MetaRow("Commands handled", deviceActivity.handled.toString())
                    MetaRow("Last command", deviceActivity.last?.type ?: "None yet")
                    MetaRow("Last result", deviceActivity.last?.describeResult() ?: "—")
                    deviceActivity.last?.error?.let { MetaRow("Last error", it) }
                }
            }
        }
        item {
            SectionTitle("Inspect current screen")
            ShivaSurface {
                Column {
                    Text(
                        "Reads the accessibility tree of whatever is on screen right now. Open the " +
                            "target app first, then switch back to Shiva and tap Inspect.",
                        style = ShivaTypography.bodySmall,
                        color = palette.muted,
                    )
                    Spacer(Modifier.height(8.dp))
                    ShivaPrimaryButton(
                        text = "Inspect",
                        loading = inspecting,
                        onClick = {
                            inspecting = true
                            scope.launch {
                                inspectOutput = when (val outcome = container.uiEngine.inspect()) {
                                    is UiOutcome.Success -> formatScreen(outcome.value)
                                    UiOutcome.ServiceUnavailable ->
                                        "Accessibility service is not enabled. Turn it on in Device Access."
                                    is UiOutcome.NotFound -> outcome.detail
                                    is UiOutcome.Failed -> outcome.reason
                                    is UiOutcome.Unsupported -> outcome.reason
                                }
                                inspecting = false
                            }
                        },
                    )
                    inspectOutput?.let { output ->
                        Spacer(Modifier.height(12.dp))
                        Text(output, style = ShivaTypography.bodySmall, color = palette.muted)
                    }
                }
            }
        }
        item {
            SectionTitle("Safe phone test")
            ShivaSurface {
                Column {
                    Text(
                        "Opens the Android dialer only. It will not place a call by itself.",
                        style = ShivaTypography.bodySmall,
                        color = palette.muted,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = dialNumber,
                        onValueChange = { dialNumber = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Number") },
                        singleLine = true,
                        shape = RoundedCornerShape(16.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = palette.accent,
                            cursorColor = palette.accent,
                        ),
                    )
                    Spacer(Modifier.height(8.dp))
                    ShivaPrimaryButton(
                        text = "Open dialer",
                        onClick = {
                            dialMessage = when (val result = container.phoneController.dial(dialNumber)) {
                                is PhoneResult.Started -> "Dialer opened."
                                is PhoneResult.Failed -> result.reason
                            }
                        },
                    )
                    if (dialMessage != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(dialMessage!!, color = palette.muted, style = ShivaTypography.bodySmall)
                    }
                }
            }
        }
        item { Spacer(Modifier.height(32.dp)) }
    }
}

private const val MAX_INSPECT_LINES = 60

private fun DeviceCommandRecord.describeResult(): String =
    "${status.name.lowercase()} in ${durationMs}ms"

private fun formatScreen(screen: UiScreen): String {
    val header = buildString {
        append("Package: ").append(screen.packageName ?: "unknown")
        screen.windowClass?.let { append("\nScreen: ").append(it.substringAfterLast('.')) }
        append("\nElements: ").append(screen.nodeCount)
        if (screen.truncated) append(" (truncated)")
    }
    if (screen.nodes.isEmpty()) return "$header\n\nNo readable elements on this screen."
    val lines = screen.nodes.take(MAX_INSPECT_LINES).joinToString("\n") { node ->
        val label = node.text
            ?: node.description
            ?: node.viewId?.substringAfterLast('/')
            ?: node.className?.substringAfterLast('.')
            ?: "view"
        val traits = buildList {
            if (node.clickable) add("click")
            if (node.editable) add("input")
            if (node.scrollable) add("scroll")
            if (!node.enabled) add("disabled")
        }
        val suffix = if (traits.isEmpty()) "" else "  [${traits.joinToString("/")}]"
        val id = node.viewId?.substringAfterLast('/')?.let { "  #$it" }.orEmpty()
        "• $label$id$suffix"
    }
    val more = (screen.nodes.size - MAX_INSPECT_LINES).takeIf { it > 0 }
        ?.let { "\n… $it more" }
        .orEmpty()
    return "$header\n\n$lines$more"
}

private fun formatInstant(epochMs: Long): String {
    return DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
        .withZone(ZoneId.systemDefault())
        .format(Instant.ofEpochMilli(epochMs))
}
