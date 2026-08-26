package com.shiva.assistant.device.sms

sealed interface SmsResult {
    data class Sent(val number: String) : SmsResult
    data class Failed(val reason: String) : SmsResult
}

interface SmsController {
    fun send(number: String, message: String): SmsResult
}
