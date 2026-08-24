package com.shiva.assistant.core.network

data class ServerUrl(
    val value: String,
) {
    fun origin(): String = value.trimEnd('/')

    fun resolve(path: String): String {
        val normalized = if (path.startsWith("/")) path else "/$path"
        return origin() + normalized
    }

    companion object {
        fun parse(raw: String): ServerUrlParseResult {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) {
                return ServerUrlParseResult.Invalid("Enter a Shiva server URL.")
            }
            val withScheme = if (SCHEME.containsMatchIn(trimmed)) trimmed else "http://$trimmed"
            val url = try {
                java.net.URI(withScheme)
            } catch (_: Exception) {
                return ServerUrlParseResult.Invalid("That does not look like a valid URL.")
            }
            val scheme = url.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") {
                return ServerUrlParseResult.Invalid("Use http or https, for example http://shiva-server:3000")
            }
            val host = url.host?.trim().orEmpty()
            if (host.isEmpty()) {
                return ServerUrlParseResult.Invalid("The URL needs a host, such as shiva-server or a Tailscale IP.")
            }
            if (host.equals("localhost", ignoreCase = true) || host == "127.0.0.1") {
                return ServerUrlParseResult.Invalid(
                    "localhost is this phone. Use your Tailscale MagicDNS name or 100.x address.",
                )
            }
            val port = if (url.port != -1) ":${url.port}" else ""
            val path = url.path.orEmpty().trimEnd('/')
            if (path.isNotEmpty() && path != "") {
                return ServerUrlParseResult.Invalid(
                    "Enter the server origin only, without a path. Example: http://shiva-server:3000",
                )
            }
            return ServerUrlParseResult.Valid(ServerUrl("$scheme://$host$port"))
        }

        private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://")
    }
}

sealed interface ServerUrlParseResult {
    data class Valid(val url: ServerUrl) : ServerUrlParseResult
    data class Invalid(val reason: String) : ServerUrlParseResult
}
