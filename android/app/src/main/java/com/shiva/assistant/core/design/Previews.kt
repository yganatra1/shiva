package com.shiva.assistant.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

@Preview(showBackground = true, backgroundColor = 0xFF0C0D0F)
@Composable
private fun ShivaThemePreview() {
    ShivaTheme(mode = ThemeMode.DARK) {
        val palette = LocalShivaPalette.current
        Column(
            modifier = Modifier
                .background(palette.background)
                .padding(24.dp),
        ) {
            Text("Shiva", style = ShivaTypography.headlineMedium, color = palette.text)
            Text("Connected", style = ShivaTypography.bodyMedium, color = palette.positive)
            ShivaPrimaryButton(text = "Continue", onClick = {})
        }
    }
}
