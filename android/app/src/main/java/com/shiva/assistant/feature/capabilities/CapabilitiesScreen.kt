package com.shiva.assistant.feature.capabilities

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.shiva.assistant.AppContainer
import com.shiva.assistant.core.design.LocalShivaPalette
import com.shiva.assistant.core.design.ShivaPrimaryButton
import com.shiva.assistant.core.design.ShivaSurface
import com.shiva.assistant.core.design.ShivaTypography
import com.shiva.assistant.device.capability.AccessRequest
import com.shiva.assistant.device.capability.AndroidCapabilityRegistry
import com.shiva.assistant.device.capability.CapabilitySnapshot
import com.shiva.assistant.device.capability.CapabilityStatus
import com.shiva.assistant.device.capability.label

@Composable
fun CapabilitiesScreen(
    container: AppContainer,
    modifier: Modifier = Modifier,
) {
    val palette = LocalShivaPalette.current
    val context = LocalContext.current
    var snapshots by remember { mutableStateOf(container.capabilities.snapshotAll()) }
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        snapshots = container.capabilities.snapshotAll()
    }
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(palette.background),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Text("Device Access", style = ShivaTypography.headlineMedium, color = palette.text)
            Spacer(Modifier.height(8.dp))
            Text(
                "These capabilities are for your self-hosted Shiva assistant. Android only grants what you enable. Shiva’s SAFE/AUTO/FULL_ACCESS policy lives on the server, not in these permissions.",
                style = ShivaTypography.bodyMedium,
                color = palette.muted,
            )
        }
        items(snapshots, key = { it.id }) { snapshot ->
            CapabilityCard(
                snapshot = snapshot,
                onEnable = {
                    val capability = container.capabilities.find(snapshot.id) ?: return@CapabilityCard
                    when (val request = capability.accessRequest()) {
                        is AccessRequest.RuntimePermissions ->
                            launcher.launch(request.permissions.toTypedArray())
                        is AccessRequest.SystemSettings ->
                            context.startActivity(
                                AndroidCapabilityRegistry.settingsIntent(request, context),
                            )
                        is AccessRequest.AppDetailsSettings -> {
                            val intent = android.content.Intent(
                                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            ).apply {
                                data = android.net.Uri.fromParts("package", context.packageName, null)
                            }
                            context.startActivity(intent)
                        }
                        AccessRequest.Unavailable -> Unit
                    }
                },
            )
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun CapabilityCard(
    snapshot: CapabilitySnapshot,
    onEnable: () -> Unit,
) {
    val palette = LocalShivaPalette.current
    val statusColor = when (snapshot.status) {
        CapabilityStatus.AVAILABLE, CapabilityStatus.ENABLED -> palette.positive
        CapabilityStatus.PERMISSION_REQUIRED,
        CapabilityStatus.REQUIRES_SYSTEM_SETTING,
        CapabilityStatus.REQUIRES_DEFAULT_APP_ROLE,
        -> palette.accent
        CapabilityStatus.DISABLED, CapabilityStatus.NOT_SUPPORTED, CapabilityStatus.FUTURE -> palette.muted
    }
    ShivaSurface {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(snapshot.title, style = ShivaTypography.titleMedium, color = palette.text)
                Text(snapshot.status.label(), style = ShivaTypography.labelSmall, color = statusColor)
            }
            Spacer(Modifier.height(8.dp))
            Text(snapshot.description, style = ShivaTypography.bodyMedium, color = palette.muted)
            Spacer(Modifier.height(8.dp))
            Text(snapshot.detail, style = ShivaTypography.bodySmall, color = palette.dim)
            if (snapshot.status != CapabilityStatus.AVAILABLE &&
                snapshot.status != CapabilityStatus.ENABLED &&
                snapshot.status != CapabilityStatus.NOT_SUPPORTED &&
                snapshot.status != CapabilityStatus.FUTURE
            ) {
                Spacer(Modifier.height(14.dp))
                ShivaPrimaryButton(text = "Enable", onClick = onEnable)
            }
        }
    }
}
