package com.shiva.assistant.device.phone

sealed interface PhoneResult {
    data class Started(val number: String, val direct: Boolean) : PhoneResult
    data class Failed(val reason: String) : PhoneResult
}

interface PhoneController {
    fun call(number: String): PhoneResult
    fun dial(number: String): PhoneResult
}

fun normalizePhoneNumber(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    val compact = trimmed.filter { it.isDigit() || it == '+' }
    if (compact.isEmpty()) return null
    val digits = compact.trimStart('+')
    if (digits.length < 3 || digits.any { !it.isDigit() }) return null
    return compact
}
