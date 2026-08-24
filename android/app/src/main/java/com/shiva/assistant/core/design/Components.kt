package com.shiva.assistant.core.design

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

val ShivaRadius = RoundedCornerShape(22.dp)

@Composable
fun ShivaPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
) {
    val palette = LocalShivaPalette.current
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        modifier = modifier
            .fillMaxWidth()
            .height(54.dp),
        shape = RoundedCornerShape(18.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = palette.accent,
            contentColor = if (palette.isDark) ShivaColors.Graphite else Color.White,
            disabledContainerColor = palette.accent.copy(alpha = 0.35f),
        ),
        contentPadding = PaddingValues(horizontal = 20.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = if (palette.isDark) ShivaColors.Graphite else Color.White,
            )
            Spacer(Modifier.width(10.dp))
        }
        Text(text = text, style = ShivaTypography.labelLarge, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun ShivaGhostButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalShivaPalette.current
    TextButton(onClick = onClick, modifier = modifier) {
        Text(text = text, color = palette.muted)
    }
}

@Composable
fun ShivaSurface(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val palette = LocalShivaPalette.current
    val clickable = if (onClick != null) {
        Modifier.clickable(role = Role.Button, onClick = onClick)
    } else {
        Modifier
    }
    Box(
        modifier = modifier
            .clip(ShivaRadius)
            .background(palette.surface)
            .border(1.dp, palette.hairline, ShivaRadius)
            .then(clickable)
            .padding(20.dp),
    ) {
        content()
    }
}

@Composable
fun ConnectionDot(
    connected: Boolean,
    modifier: Modifier = Modifier,
    pulse: Boolean = false,
) {
    val palette = LocalShivaPalette.current
    val infinite = rememberInfiniteTransition(label = "dot")
    val alpha by infinite.animateFloat(
        initialValue = 1f,
        targetValue = if (pulse) 0.35f else 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1100, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "dotAlpha",
    )
    Box(
        modifier = modifier
            .size(8.dp)
            .alpha(alpha)
            .clip(CircleShape)
            .background(if (connected) palette.positive else palette.muted),
    )
}

@Composable
fun StatusChip(
    label: String,
    connected: Boolean,
    modifier: Modifier = Modifier,
    connecting: Boolean = false,
) {
    val palette = LocalShivaPalette.current
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (connected) ShivaColors.SageSoft else palette.elevated)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ConnectionDot(connected = connected, pulse = connecting)
        Text(
            text = label,
            style = ShivaTypography.labelSmall,
            color = if (connected) palette.positive else palette.muted,
        )
    }
}

@Composable
fun EmptyState(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
) {
    val palette = LocalShivaPalette.current
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = ShivaTypography.headlineSmall, color = palette.text)
        Spacer(Modifier.height(8.dp))
        Text(body, style = ShivaTypography.bodyMedium, color = palette.muted)
    }
}
