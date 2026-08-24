package com.shiva.assistant.core.network

import com.shiva.assistant.core.logging.ShivaLog
import com.shiva.assistant.core.security.DeviceTokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.logging.HttpLoggingInterceptor
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class OkHttpShivaClient(
    private val urlProvider: () -> String?,
    private val tokenStore: DeviceTokenStore,
    private val json: Json = ShivaJson,
    chatTimeoutMs: Long = 300_000,
) : ShivaClient {

    private val mediaType = "application/json; charset=utf-8".toMediaType()

    private val logging = HttpLoggingInterceptor { message ->
        ShivaLog.d(ShivaLog.NETWORK, message)
    }.apply {
        level = HttpLoggingInterceptor.Level.BASIC
        redactHeader("Authorization")
        redactHeader("Cookie")
    }

    private val healthClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(8, TimeUnit.SECONDS)
        .addInterceptor(logging)
        .addInterceptor(AuthInterceptor(tokenStore))
        .build()

    private val chatClient = healthClient.newBuilder()
        .readTimeout(chatTimeoutMs, TimeUnit.MILLISECONDS)
        .callTimeout(chatTimeoutMs, TimeUnit.MILLISECONDS)
        .build()

    private val updateClient = healthClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    override suspend fun health(): HealthResult = withContext(Dispatchers.IO) {
        val started = System.nanoTime()
        val url = resolvedUrl() ?: return@withContext HealthResult(
            reachable = false,
            latencyMs = null,
            status = null,
            name = null,
            version = null,
            model = null,
            error = ShivaError.InvalidUrl("Set a Shiva server URL first."),
        )
        val request = Request.Builder().url(url.resolve("/health")).get().build()
        try {
            healthClient.newCall(request).execute().use { response ->
                val latency = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    return@withContext HealthResult(
                        reachable = false,
                        latencyMs = latency,
                        status = null,
                        name = null,
                        version = null,
                        model = null,
                        error = mapHttpFailure(response.code, body),
                    )
                }
                val payload = runCatching { json.decodeFromString<HealthPayload>(body) }.getOrNull()
                HealthResult(
                    reachable = payload?.status.equals("ok", ignoreCase = true),
                    latencyMs = latency,
                    status = payload?.status,
                    name = payload?.name,
                    version = payload?.version,
                    model = payload?.model,
                    error = if (payload?.status.equals("ok", ignoreCase = true)) {
                        null
                    } else {
                        ShivaError.Api("HEALTH", "Shiva health did not report ok.", response.code)
                    },
                )
            }
        } catch (error: IOException) {
            ShivaLog.w(ShivaLog.NETWORK, "Health check failed: ${error.javaClass.simpleName}")
            HealthResult(
                reachable = false,
                latencyMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started),
                status = null,
                name = null,
                version = null,
                model = null,
                error = mapIoFailure(error),
            )
        }
    }

    override fun sendMessage(
        conversationId: String?,
        message: String,
        images: List<String>,
    ): Flow<ChatStreamEvent> = callbackFlow {
        val url = resolvedUrl()
        if (url == null) {
            trySend(ChatStreamEvent.Failed(ShivaError.InvalidUrl("Set a Shiva server URL first.")))
            close()
            return@callbackFlow
        }
        val payload = json.encodeToString(
            ChatRequestPayload(
                message = message,
                conversationId = conversationId,
                images = images.takeIf { it.isNotEmpty() },
            ),
        )
        val request = Request.Builder()
            .url(url.resolve("/chat"))
            .post(payload.toRequestBody(mediaType))
            .header("Accept", "text/plain")
            .build()
        val call = chatClient.newCall(request)
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                trySend(ChatStreamEvent.Failed(mapIoFailure(e)))
                close()
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { used ->
                    val conversationHeader = used.header("x-shiva-conversation-id")
                    if (!used.isSuccessful) {
                        val errorBody = used.body?.string()
                        trySend(ChatStreamEvent.Failed(mapHttpFailure(used.code, errorBody)))
                        close()
                        return
                    }
                    trySend(ChatStreamEvent.Started(conversationHeader))
                    val body = used.body
                    if (body == null) {
                        trySend(ChatStreamEvent.Failed(ShivaError.Unexpected("Empty chat body")))
                        close()
                        return
                    }
                    try {
                        val source = body.source()
                        val buffer = okio.Buffer()
                        while (!source.exhausted()) {
                            val read = source.read(buffer, 4_096)
                            if (read <= 0) continue
                            val chunk = buffer.readUtf8()
                            if (chunk.isNotEmpty()) {
                                trySend(ChatStreamEvent.Delta(chunk))
                            }
                        }
                        trySend(ChatStreamEvent.Completed)
                        close()
                    } catch (error: IOException) {
                        trySend(ChatStreamEvent.Failed(mapIoFailure(error)))
                        close()
                    }
                }
            }
        })
        awaitClose { call.cancel() }
    }

    override fun coreUpdates(
        conversationId: String,
        afterMessageId: String?,
    ): Flow<CoreAssistantUpdate> = callbackFlow {
        val url = resolvedUrl()
        if (url == null) {
            close(IllegalStateException("Set a Shiva server URL first."))
            return@callbackFlow
        }
        val request = Request.Builder()
            .url(coreUpdateWebSocketUrl(url.origin(), conversationId, afterMessageId))
            .build()
        val socket = updateClient.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    ShivaLog.i(ShivaLog.CONNECTION, "Core update WebSocket connected")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val payload = runCatching {
                        json.decodeFromString<CoreAssistantUpdatePayload>(text)
                    }.getOrElse { error ->
                        ShivaLog.w(
                            ShivaLog.NETWORK,
                            "Ignoring malformed Core update: ${error.javaClass.simpleName}",
                        )
                        return
                    }
                    if (payload.conversationId != conversationId) {
                        ShivaLog.w(ShivaLog.NETWORK, "Ignoring Core update for another conversation")
                        return
                    }
                    trySend(payload.toUpdate())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (code == NORMAL_SOCKET_CLOSE_CODE) {
                        close()
                    } else {
                        close(CoreUpdateSocketClosedException(code, reason))
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    ShivaLog.w(
                        ShivaLog.CONNECTION,
                        "Core update WebSocket failure: ${t.javaClass.simpleName}",
                    )
                    close(t)
                }
            },
        )
        awaitClose { socket.cancel() }
    }

    private fun resolvedUrl(): ServerUrl? {
        val raw = urlProvider() ?: return null
        return when (val parsed = ServerUrl.parse(raw)) {
            is ServerUrlParseResult.Valid -> parsed.url
            is ServerUrlParseResult.Invalid -> null
        }
    }
}

internal fun coreUpdateWebSocketUrl(
    origin: String,
    conversationId: String,
    afterMessageId: String? = null,
): String {
    val base = httpOriginToWebSocket(origin, "/chat/updates")
    val conversation = URLEncoder.encode(conversationId, "UTF-8")
    val cursor = afterMessageId
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.let { "&afterMessageId=${URLEncoder.encode(it, "UTF-8")}" }
        .orEmpty()
    return "$base?conversationId=$conversation$cursor&limit=100"
}

private class AuthInterceptor(
    private val tokenStore: DeviceTokenStore,
) : okhttp3.Interceptor {
    override fun intercept(chain: okhttp3.Interceptor.Chain): okhttp3.Response {
        val token = tokenStore.token()
        val request = if (token.isNullOrBlank()) {
            chain.request()
        } else {
            chain.request().newBuilder()
                .header("Authorization", "Bearer $token")
                .build()
        }
        return chain.proceed(request)
    }
}

@Serializable
private data class HealthPayload(
    val status: String,
    val name: String? = null,
    val version: String? = null,
    val model: String? = null,
)

@Serializable
private data class ChatRequestPayload(
    val message: String,
    val conversationId: String? = null,
    val images: List<String>? = null,
)

@Serializable
private data class CoreAssistantUpdatePayload(
    val messageId: String,
    val conversationId: String,
    val message: String,
    val timestamp: String,
) {
    fun toUpdate() = CoreAssistantUpdate(
        messageId = messageId,
        conversationId = conversationId,
        message = message,
        timestamp = timestamp,
    )
}

private const val NORMAL_SOCKET_CLOSE_CODE = 1000

val ShivaJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
}
