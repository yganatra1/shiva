package com.shiva.assistant.feature.onboarding

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.shiva.assistant.AppContainer
import com.shiva.assistant.core.design.LocalShivaPalette
import com.shiva.assistant.core.design.ShivaGhostButton
import com.shiva.assistant.core.design.ShivaPrimaryButton
import com.shiva.assistant.core.design.ShivaTypography
import com.shiva.assistant.core.network.ServerUrl
import com.shiva.assistant.core.network.ServerUrlParseResult
import com.shiva.assistant.data.settings.AppSettings
import com.shiva.assistant.device.capability.AccessRequest
import com.shiva.assistant.device.capability.AndroidCapabilityRegistry
import com.shiva.assistant.device.capability.CapabilityId
import kotlinx.coroutines.launch

@Composable
fun OnboardingScreen(
    container: AppContainer,
    settings: AppSettings,
    onFinished: () -> Unit,
) {
    val palette = LocalShivaPalette.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableIntStateOf(0) }
    var url by remember { mutableStateOf(settings.persisted.serverUrl.orEmpty()) }
    var urlError by remember { mutableStateOf<String?>(null) }
    var connecting by remember { mutableStateOf(false) }
    var connectError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.background)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .padding(horizontal = 24.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        AnimatedContent(targetState = step, label = "onboarding") { current ->
            when (current) {
                0 -> CopyBlock(
                    eyebrow = "SHIVA",
                    title = "Meet Shiva",
                    body = "Your personal AI. Running on your infrastructure. This phone is a trusted device, not the brain.",
                )
                1 -> Column {
                    CopyBlock(
                        eyebrow = "CONNECT",
                        title = "Connect to Shiva",
                        body = "Your phone communicates privately with your Shiva server over your Tailscale network.",
                    )
                    Spacer(Modifier.height(28.dp))
                    OutlinedTextField(
                        value = url,
                        onValueChange = {
                            url = it
                            urlError = null
                            connectError = null
                        },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Server URL") },
                        placeholder = { Text("http://shiva-server:3000") },
                        singleLine = true,
                        isError = urlError != null,
                        shape = RoundedCornerShape(18.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = palette.accent,
                            focusedLabelColor = palette.accent,
                            cursorColor = palette.accent,
                        ),
                        supportingText = {
                            Text(
                                urlError
                                    ?: "Use a Tailscale MagicDNS name or 100.x address. Do not use localhost.",
                            )
                        },
                    )
                }
                2 -> CopyBlock(
                    eyebrow = "PHONE ACCESS",
                    title = "You stay in control",
                    body = "Shiva can eventually help with calls, contacts, notifications and other phone actions. Android permissions stay in your hands.",
                )
                else -> CopyBlock(
                    eyebrow = "READY",
                    title = "Shiva is ready.",
                    body = "Chat from this phone over Tailscale. Device skills can be added without rebuilding the foundation.",
                )
            }
        }
        Column {
            if (step == 1 && connectError != null) {
                Text(connectError!!, color = palette.danger, style = ShivaTypography.bodySmall)
                Spacer(Modifier.height(8.dp))
            }
            ShivaPrimaryButton(
                text = when (step) {
                    0 -> "Continue"
                    1 -> "Test & continue"
                    2 -> "Continue"
                    else -> "Start chatting"
                },
                loading = connecting,
                onClick = {
                    when (step) {
                        0 -> step = 1
                        1 -> {
                            when (val parsed = ServerUrl.parse(url)) {
                                is ServerUrlParseResult.Invalid -> urlError = parsed.reason
                                is ServerUrlParseResult.Valid -> {
                                    connecting = true
                                    connectError = null
                                    scope.launch {
                                        container.settingsRepository.saveServerUrl(parsed.url.origin())
                                        container.rememberServerUrl(parsed.url.origin())
                                        val result = container.connectionMonitor.probe(silent = false)
                                        connecting = false
                                        if (result.reachable) {
                                            step = 2
                                        } else {
                                            connectError = result.error?.publicMessage
                                                ?: "Unable to reach Shiva."
                                        }
                                    }
                                }
                            }
                        }
                        2 -> step = 3
                        else -> scope.launch {
                            container.settingsRepository.completeOnboarding()
                            onFinished()
                        }
                    }
                },
            )
            if (step == 2) {
                ShivaGhostButton(
                    text = "Skip phone access for now",
                    onClick = { step = 3 },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                QuickAccessRow(container)
            }
        }
    }
}

@Composable
private fun CopyBlock(eyebrow: String, title: String, body: String) {
    val palette = LocalShivaPalette.current
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(eyebrow, style = ShivaTypography.labelSmall, color = palette.accent)
        Spacer(Modifier.height(18.dp))
        Text(title, style = ShivaTypography.displaySmall, color = palette.text)
        Spacer(Modifier.height(16.dp))
        Text(body, style = ShivaTypography.bodyLarge, color = palette.muted)
    }
}

@Composable
private fun QuickAccessRow(container: AppContainer) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        listOfNotNull(
            container.capabilities.find(CapabilityId.CONTACTS),
            container.capabilities.find(CapabilityId.MICROPHONE),
        ).forEach { capability ->
            ShivaGhostButton(
                text = "Enable ${capability.snapshot().title.lowercase()}",
                onClick = {
                    when (val request = capability.accessRequest()) {
                        is AccessRequest.RuntimePermissions ->
                            launcher.launch(request.permissions.toTypedArray())
                        is AccessRequest.SystemSettings ->
                            context.startActivity(
                                AndroidCapabilityRegistry.settingsIntent(request, context),
                            )
                        else -> Unit
                    }
                },
            )
        }
    }
}
