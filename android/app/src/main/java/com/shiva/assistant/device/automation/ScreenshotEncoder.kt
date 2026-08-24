package com.shiva.assistant.device.automation

import android.graphics.Bitmap
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * Screenshots travel inside a single device-command result field, and the server rejects fields
 * over 1.5M characters. Base64 inflates by 4/3, so the byte budget stays well under that.
 */
internal object ScreenshotEncoder {
    private const val MAX_BYTES = 700 * 1024

    fun encode(bitmap: Bitmap, maxEdgePx: Int): UiScreenshot? {
        val scaled = scaleDown(bitmap, maxEdgePx.coerceIn(240, 2160))
        return try {
            compressToLimit(scaled)?.let { bytes ->
                UiScreenshot(
                    base64Jpeg = Base64.encodeToString(bytes, Base64.NO_WRAP),
                    width = scaled.width,
                    height = scaled.height,
                )
            }
        } finally {
            if (scaled !== bitmap) scaled.recycle()
        }
    }

    private fun scaleDown(bitmap: Bitmap, maxEdge: Int): Bitmap {
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest <= maxEdge) return bitmap
        val scale = maxEdge.toFloat() / longest.toFloat()
        val width = (bitmap.width * scale).toInt().coerceAtLeast(1)
        val height = (bitmap.height * scale).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }

    private fun compressToLimit(bitmap: Bitmap): ByteArray? {
        var quality = 80
        while (quality >= 35) {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            val bytes = out.toByteArray()
            if (bytes.size <= MAX_BYTES) return bytes
            quality -= 15
        }
        return null
    }
}
