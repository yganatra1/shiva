package com.shiva.assistant.core.network

sealed interface ShivaError {
    val publicMessage: String
    val technicalMessage: String
    val code: String?

    data class InvalidUrl(override val publicMessage: String) : ShivaError {
        override val technicalMessage: String = publicMessage
        override val code: String? = "INVALID_URL"
    }

    data class Unreachable(
        override val technicalMessage: String,
        override val publicMessage: String = "Unable to reach Shiva. Check Tailscale, the server, and the configured address.",
    ) : ShivaError {
        override val code: String? = "UNREACHABLE"
    }

    data class Timeout(
        override val publicMessage: String = "Shiva did not respond in time.",
    ) : ShivaError {
        override val technicalMessage: String = publicMessage
        override val code: String? = "TIMEOUT"
    }

    data class AuthenticationFailed(
        override val publicMessage: String = "Shiva rejected this device’s credentials.",
    ) : ShivaError {
        override val technicalMessage: String = publicMessage
        override val code: String? = "AUTH_FAILED"
    }

    data class Api(
        override val code: String?,
        override val publicMessage: String,
        val httpStatus: Int,
    ) : ShivaError {
        override val technicalMessage: String = "HTTP $httpStatus ${code ?: ""} $publicMessage".trim()
    }

    data class Unexpected(
        override val technicalMessage: String,
        override val publicMessage: String = "Shiva could not complete the request.",
    ) : ShivaError {
        override val code: String? = "INTERNAL"
    }
}

fun mapHttpFailure(status: Int, body: String?): ShivaError {
    if (status == 401 || status == 403) {
        return ShivaError.AuthenticationFailed()
    }
    val parsed = parseApiError(body)
    val message = parsed?.message ?: defaultMessageForStatus(status)
    return ShivaError.Api(
        code = parsed?.code,
        publicMessage = message,
        httpStatus = status,
    )
}

fun mapIoFailure(throwable: Throwable): ShivaError {
    val text = throwable.javaClass.simpleName
    return when {
        text.contains("Timeout", ignoreCase = true) ||
            throwable.message?.contains("timeout", ignoreCase = true) == true -> ShivaError.Timeout()
        else -> ShivaError.Unreachable(technicalMessage = text)
    }
}

internal data class ParsedApiError(val code: String?, val message: String)

internal fun parseApiError(body: String?): ParsedApiError? {
    if (body.isNullOrBlank()) return null
    val code = CODE.find(body)?.groupValues?.getOrNull(1)
    val message = MESSAGE.find(body)?.groupValues?.getOrNull(1)
    if (code == null && message == null) return null
    return ParsedApiError(code = code, message = message ?: "Shiva returned an error.")
}

private fun defaultMessageForStatus(status: Int): String = when (status) {
    404 -> "The requested conversation does not exist."
    413 -> "That message is too large."
    415 -> "Shiva rejected the request format."
    499 -> "The request was cancelled."
    502, 503 -> "Shiva’s local model is currently unavailable."
    504 -> "Shiva’s local model did not respond in time."
    else -> "Shiva could not complete the request."
}

private val CODE = Regex("\"code\"\\s*:\\s*\"([^\"]+)\"")
private val MESSAGE = Regex("\"message\"\\s*:\\s*\"([^\"]+)\"")
