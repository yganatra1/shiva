package com.shiva.assistant.device.location

sealed interface LocationResult {
    data class Found(
        val latitude: Double,
        val longitude: Double,
        val accuracyMeters: Float,
        val ageMs: Long,
    ) : LocationResult
    data class Failed(val reason: String) : LocationResult
}

interface LocationController {
    suspend fun getLocation(): LocationResult
}
