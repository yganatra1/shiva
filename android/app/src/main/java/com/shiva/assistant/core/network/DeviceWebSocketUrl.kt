package com.shiva.assistant.core.network

import java.net.URLEncoder

internal fun httpOriginToWebSocket(origin: String, path: String): String {
    val normalizedPath = if (path.startsWith("/")) path else "/$path"
    val wsOrigin = when {
        origin.startsWith("https://", ignoreCase = true) ->
            "wss://" + origin.substring("https://".length)
        origin.startsWith("http://", ignoreCase = true) ->
            "ws://" + origin.substring("http://".length)
        else -> origin
    }.trimEnd('/')
    return wsOrigin + normalizedPath
}

/** The Shiva server gates `/device/ws` with an optional `?token=` query param (DEVICE_WS_TOKEN). */
internal fun deviceWebSocketUrl(origin: String, path: String, token: String? = null): String {
    val base = httpOriginToWebSocket(origin, path)
    val trimmed = token?.trim()?.takeIf { it.isNotEmpty() } ?: return base
    // The Charset overload is API 33+, and Shiva supports API 26.
    val encoded = URLEncoder.encode(trimmed, "UTF-8")
    val separator = if (base.contains('?')) "&" else "?"
    return "$base${separator}token=$encoded"
}
