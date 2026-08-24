package com.shiva.assistant.feature.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream

internal object ChatImageEncoder {
    private const val MAX_EDGE_PX = 1280
    private const val MAX_BYTES = 384 * 1024

    fun encodeJpegBase64(context: Context, uri: Uri): String? {
        val original = context.contentResolver.openInputStream(uri)?.use { stream ->
            BitmapFactory.decodeStream(stream)
        } ?: return null
        return try {
            val scaled = scaleDown(original, MAX_EDGE_PX)
            try {
                compressToLimit(scaled, MAX_BYTES)?.let { bytes ->
                    Base64.encodeToString(bytes, Base64.NO_WRAP)
                }
            } finally {
                if (scaled !== original) scaled.recycle()
            }
        } finally {
            original.recycle()
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

    private fun compressToLimit(bitmap: Bitmap, maxBytes: Int): ByteArray? {
        var quality = 85
        while (quality >= 40) {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            val bytes = out.toByteArray()
            if (bytes.size <= maxBytes) return bytes
            quality -= 10
        }
        return null
    }
}
