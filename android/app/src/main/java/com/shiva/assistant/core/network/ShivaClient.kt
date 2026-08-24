package com.shiva.assistant.core.network

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

data class HealthResult(
    val reachable: Boolean,
    val latencyMs: Long?,
    val status: String?,
    val name: String?,
    val version: String?,
    val model: String?,
    val error: ShivaError?,
)

data class ChatRequest(
    val conversationId: String?,
    val message: String,
    val images: List<String> = emptyList(),
)

sealed interface ChatStreamEvent {
    data class Started(val conversationId: String?) : ChatStreamEvent
    data class Delta(val text: String) : ChatStreamEvent
    data object Completed : ChatStreamEvent
    data class Failed(val error: ShivaError) : ChatStreamEvent
}

/** A Core-authored assistant message produced after an asynchronous agent response. */
data class CoreAssistantUpdate(
    val messageId: String,
    val conversationId: String,
    val message: String,
    val timestamp: String,
)

/**
 * Raised when the update WebSocket closes abnormally. Code 4404 means the
 * persisted replay cursor is no longer known to Core and the client may
 * reconnect without it.
 */
class CoreUpdateSocketClosedException(
    val closeCode: Int,
    val closeReason: String,
) : java.io.IOException("Core update socket closed ($closeCode): $closeReason")

interface ShivaClient {
    suspend fun health(): HealthResult

    fun sendMessage(
        conversationId: String?,
        message: String,
        images: List<String> = emptyList(),
    ): Flow<ChatStreamEvent>

    /**
     * Observe durable, asynchronous Core replies for one conversation.
     * Implementations emit only parsed assistant messages and complete when
     * the underlying socket closes; the repository owns reconnect policy.
     */
    fun coreUpdates(
        conversationId: String,
        afterMessageId: String? = null,
    ): Flow<CoreAssistantUpdate> = emptyFlow()
}

interface DeviceRegistrationClient {
    suspend fun register(profile: DeviceRegistrationProfile): DeviceRegistrationResult
}

data class DeviceRegistrationProfile(
    val deviceId: String,
    val name: String,
    val platform: String,
    val capabilities: List<String>,
    val appVersion: String,
    val androidVersion: String,
    val deviceModel: String,
)

sealed interface DeviceRegistrationResult {
    data object Unsupported : DeviceRegistrationResult
    data class Registered(val serverDeviceId: String) : DeviceRegistrationResult
    data class Failed(val error: ShivaError) : DeviceRegistrationResult
}

class UnsupportedDeviceRegistrationClient : DeviceRegistrationClient {
    override suspend fun register(profile: DeviceRegistrationProfile): DeviceRegistrationResult {
        return DeviceRegistrationResult.Unsupported
    }
}
