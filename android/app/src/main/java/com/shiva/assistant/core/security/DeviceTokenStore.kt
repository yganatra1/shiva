package com.shiva.assistant.core.security

interface DeviceTokenStore {
    fun token(): String?
    fun save(token: String)
    fun clear()
}
