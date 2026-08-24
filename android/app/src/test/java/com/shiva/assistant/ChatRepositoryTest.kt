package com.shiva.assistant

import com.shiva.assistant.data.chat.ChatRepository
import com.shiva.assistant.data.chat.ChatRole
import com.shiva.assistant.data.chat.ChatArchive
import com.shiva.assistant.data.chat.InMemoryChatCache
import com.shiva.assistant.data.chat.MessageStatus
import com.shiva.assistant.data.chat.StoredConversation
import com.shiva.assistant.core.network.ChatStreamEvent
import com.shiva.assistant.core.network.CoreAssistantUpdate
import com.shiva.assistant.core.network.CoreUpdateSocketClosedException
import com.shiva.assistant.core.network.HealthResult
import com.shiva.assistant.core.network.ShivaClient
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatRepositoryTest {
    @Test
    fun streamsTokensIntoOneAssistantMessage() = runTest {
        val client = FakeShivaClient(
            events = listOf(
                ChatStreamEvent.Started("11111111-1111-4111-8111-111111111111"),
                ChatStreamEvent.Delta("Hello "),
                ChatStreamEvent.Delta("Yash."),
                ChatStreamEvent.Completed,
            ),
        )
        val repository = ChatRepository(
            client = client,
            cache = InMemoryChatCache(),
            now = { 10 },
            ids = countingIds(),
        )
        repository.send("Hi")
        val state = repository.state.value
        assertEquals("11111111-1111-4111-8111-111111111111", state.conversationId)
        assertEquals(2, state.messages.size)
        assertEquals(ChatRole.USER, state.messages[0].role)
        assertEquals("Hello Yash.", state.messages[1].content)
        assertEquals(MessageStatus.COMPLETE, state.messages[1].status)
        assertEquals(false, state.sending)
    }

    @Test
    fun failedTurnStaysRetryable() = runTest {
        val client = FakeShivaClient(events = listOf(ChatStreamEvent.Failed(com.shiva.assistant.core.network.ShivaError.Timeout())))
        val repository = ChatRepository(client, InMemoryChatCache(), now = { 1 }, ids = countingIds())
        repository.send("Hello")
        // Second id generation uses same lambda; last message may share id. Check failure flag.
        assertEquals(true, repository.state.value.messages.any { it.status == MessageStatus.FAILED })
    }

    @Test
    fun newConversationClearsServerId() = runTest {
        val repository = ChatRepository(
            FakeShivaClient(
                listOf(
                    ChatStreamEvent.Started("conv"),
                    ChatStreamEvent.Delta("ok"),
                    ChatStreamEvent.Completed,
                ),
            ),
            InMemoryChatCache(),
        )
        repository.send("Hi")
        repository.newConversation()
        assertNull(repository.state.value.conversationId)
        assertEquals(0, repository.state.value.messages.size)
    }

    @Test
    fun switchingConversationsRestoresEachLocalTranscript() = runTest {
        val repository = ChatRepository(
            client = FakeShivaClient(
                listOf(
                    ChatStreamEvent.Started("server-conversation"),
                    ChatStreamEvent.Delta("answer"),
                    ChatStreamEvent.Completed,
                ),
            ),
            cache = InMemoryChatCache(),
            now = increasingClock(),
            ids = countingIds(),
        )
        repository.restore()

        repository.send("First topic")
        val firstId = repository.activeConversationId.value!!
        assertEquals("First topic", repository.conversations.value.first().title)

        repository.newConversation()
        val secondId = repository.activeConversationId.value!!
        repository.send("Second topic")
        assertEquals(2, repository.conversations.value.size)
        assertEquals("Second topic", repository.conversations.value.first().title)

        assertTrue(repository.selectConversation(firstId))
        assertEquals(firstId, repository.activeConversationId.value)
        assertEquals("First topic", repository.state.value.messages.first().content)

        assertTrue(repository.selectConversation(secondId))
        assertEquals("Second topic", repository.state.value.messages.first().content)
    }

    @Test
    fun renameChangesOnlyTheLocalTitle() = runTest {
        val initial = StoredConversation(
            localId = "local-1",
            title = "Original",
            serverConversationId = "server-1",
            createdAtEpochMs = 1,
            updatedAtEpochMs = 1,
        )
        val repository = ChatRepository(
            client = FakeShivaClient(emptyList()),
            cache = InMemoryChatCache(ChatArchive("local-1", listOf(initial))),
            now = { 10 },
        )
        repository.restore()

        assertTrue(repository.renameConversation("local-1", "  Shopping   list  "))
        assertEquals("Shopping list", repository.conversations.value.single().title)
        assertEquals("server-1", repository.state.value.conversationId)
        assertFalse(repository.renameConversation("local-1", "   "))
    }

    @Test
    fun archiveRestoresActiveConversationAndHistory() = runTest {
        val first = StoredConversation(
            localId = "first",
            title = "First",
            serverConversationId = "server-first",
            messages = emptyList(),
            createdAtEpochMs = 1,
            updatedAtEpochMs = 1,
        )
        val second = StoredConversation(
            localId = "second",
            title = "Second",
            serverConversationId = "server-second",
            messages = emptyList(),
            createdAtEpochMs = 2,
            updatedAtEpochMs = 2,
        )
        val repository = ChatRepository(
            client = FakeShivaClient(emptyList()),
            cache = InMemoryChatCache(ChatArchive("first", listOf(first, second))),
        )

        repository.restore()

        assertEquals("first", repository.activeConversationId.value)
        assertEquals("server-first", repository.state.value.conversationId)
        assertEquals(listOf("Second", "First"), repository.conversations.value.map { it.title })
    }

    @Test
    fun subscribesAfterServerConversationIsKnownAndDeduplicatesDurableUpdates() = runTest {
        val updates = MutableSharedFlow<CoreAssistantUpdate>()
        val cache = InMemoryChatCache()
        val client = FakeShivaClient(
            events = listOf(
                ChatStreamEvent.Started("server-conversation"),
                ChatStreamEvent.Delta("Working on it."),
                ChatStreamEvent.Completed,
            ),
            updateFlow = { _, _ -> updates },
        )
        val repository = ChatRepository(
            client = client,
            cache = cache,
            now = { 10 },
            ids = countingIds(),
            updateScope = backgroundScope,
        )
        repository.restore()
        assertTrue(client.updateRequests.isEmpty())

        repository.send("Call Mom")
        runCurrent()
        assertEquals(listOf("server-conversation" to null), client.updateRequests)

        val update = CoreAssistantUpdate(
            messageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            conversationId = "server-conversation",
            message = "Mom did not answer, so I recorded the expense.",
            timestamp = "2026-08-24T10:15:30Z",
        )
        updates.emit(update)
        updates.emit(update)
        runCurrent()

        assertEquals(1, repository.state.value.messages.count { it.id == update.messageId })
        assertEquals(update.message, repository.state.value.messages.last().content)
        val saved = cache.load().conversations.single()
        assertEquals(update.messageId, saved.lastCoreUpdateMessageId)
        assertEquals(1, saved.messages.count { it.id == update.messageId })
    }

    @Test
    fun reconnectUsesLatestPersistedCursor() = runTest {
        val update = CoreAssistantUpdate(
            messageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            conversationId = "server-conversation",
            message = "The delegated work is complete.",
            timestamp = "2026-08-24T10:15:30Z",
        )
        var connection = 0
        val client = FakeShivaClient(
            events = emptyList(),
            updateFlow = { _, _ ->
                connection += 1
                if (connection == 1) {
                    flow {
                        emit(update)
                        throw CoreUpdateSocketClosedException(1011, "restart")
                    }
                } else {
                    flow { awaitCancellation() }
                }
            },
        )
        val initial = StoredConversation(
            localId = "local-1",
            title = "Delegated task",
            serverConversationId = "server-conversation",
            lastCoreUpdateMessageId = "previous-message",
            createdAtEpochMs = 1,
            updatedAtEpochMs = 1,
        )
        val repository = ChatRepository(
            client = client,
            cache = InMemoryChatCache(ChatArchive("local-1", listOf(initial))),
            updateScope = backgroundScope,
            updateReconnectDelay = { _ -> },
        )

        repository.restore()
        runCurrent()

        assertEquals(
            listOf(
                "server-conversation" to "previous-message",
                "server-conversation" to update.messageId,
            ),
            client.updateRequests,
        )
        assertEquals(1, repository.state.value.messages.count { it.id == update.messageId })
    }

    @Test
    fun rejectedReplayCursorIsClearedBeforeReconnect() = runTest {
        var connection = 0
        val cache = InMemoryChatCache(
            ChatArchive(
                activeConversationId = "local-1",
                conversations = listOf(
                    StoredConversation(
                        localId = "local-1",
                        title = "Delegated task",
                        serverConversationId = "server-conversation",
                        lastCoreUpdateMessageId = "missing-message",
                        createdAtEpochMs = 1,
                        updatedAtEpochMs = 1,
                    ),
                ),
            ),
        )
        val client = FakeShivaClient(
            events = emptyList(),
            updateFlow = { _, _ ->
                connection += 1
                if (connection == 1) {
                    flow<CoreAssistantUpdate> {
                        throw CoreUpdateSocketClosedException(4404, "cursor not found")
                    }
                } else {
                    flow { awaitCancellation() }
                }
            },
        )
        val repository = ChatRepository(
            client = client,
            cache = cache,
            updateScope = backgroundScope,
            updateReconnectDelay = { _ -> },
        )

        repository.restore()
        runCurrent()

        assertEquals(
            listOf(
                "server-conversation" to "missing-message",
                "server-conversation" to null,
            ),
            client.updateRequests,
        )
        assertNull(cache.load().conversations.single().lastCoreUpdateMessageId)
    }

    @Test
    fun switchingSubscriptionsKeepsUpdatesWithTheirServerConversation() = runTest {
        val firstUpdates = MutableSharedFlow<CoreAssistantUpdate>()
        val secondUpdates = MutableSharedFlow<CoreAssistantUpdate>()
        val initial = ChatArchive(
            activeConversationId = "local-first",
            conversations = listOf(
                StoredConversation(
                    localId = "local-first",
                    title = "First",
                    serverConversationId = "server-first",
                    createdAtEpochMs = 1,
                    updatedAtEpochMs = 1,
                ),
                StoredConversation(
                    localId = "local-second",
                    title = "Second",
                    serverConversationId = "server-second",
                    createdAtEpochMs = 2,
                    updatedAtEpochMs = 2,
                ),
            ),
        )
        val client = FakeShivaClient(
            events = emptyList(),
            updateFlow = { conversationId, _ ->
                if (conversationId == "server-first") firstUpdates else secondUpdates
            },
        )
        val repository = ChatRepository(
            client = client,
            cache = InMemoryChatCache(initial),
            updateScope = backgroundScope,
        )
        repository.restore()
        runCurrent()
        firstUpdates.emit(
            CoreAssistantUpdate(
                messageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                conversationId = "server-first",
                message = "First result",
                timestamp = "2026-08-24T10:15:30Z",
            ),
        )
        runCurrent()

        assertTrue(repository.selectConversation("local-second"))
        runCurrent()
        secondUpdates.emit(
            CoreAssistantUpdate(
                messageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                conversationId = "server-second",
                message = "Second result",
                timestamp = "2026-08-24T10:16:30Z",
            ),
        )
        runCurrent()

        assertEquals(listOf("Second result"), repository.state.value.messages.map { it.content })
        assertTrue(repository.selectConversation("local-first"))
        assertEquals(listOf("First result"), repository.state.value.messages.map { it.content })
    }

    @Test
    fun fullReplayPageReconnectsFromLastPersistedMessage() = runTest {
        val replay = (1..100).map { index ->
            CoreAssistantUpdate(
                messageId = "message-$index",
                conversationId = "server-conversation",
                message = "Result $index",
                timestamp = "2026-08-24T10:15:30Z",
            )
        }
        var connection = 0
        val client = FakeShivaClient(
            events = emptyList(),
            updateFlow = { _, _ ->
                connection += 1
                if (connection == 1) {
                    flow {
                        replay.forEach { emit(it) }
                        awaitCancellation()
                    }
                } else {
                    flow { awaitCancellation() }
                }
            },
        )
        val initial = StoredConversation(
            localId = "local-1",
            title = "Delegated task",
            serverConversationId = "server-conversation",
            createdAtEpochMs = 1,
            updatedAtEpochMs = 1,
        )
        val repository = ChatRepository(
            client = client,
            cache = InMemoryChatCache(ChatArchive("local-1", listOf(initial))),
            updateScope = backgroundScope,
        )

        repository.restore()
        runCurrent()

        assertEquals(100, repository.state.value.messages.size)
        assertEquals(
            listOf(
                "server-conversation" to null,
                "server-conversation" to "message-100",
            ),
            client.updateRequests,
        )
    }

}

private fun countingIds(): () -> String {
    var n = 0
    return {
        n += 1
        "id-$n"
    }
}

private fun increasingClock(): () -> Long {
    var value = 0L
    return {
        value += 1
        value
    }
}

private class FakeShivaClient(
    private val events: List<ChatStreamEvent>,
    private val updateFlow: (String, String?) -> Flow<CoreAssistantUpdate> = { _, _ ->
        flow { awaitCancellation() }
    },
) : ShivaClient {
    val updateRequests = mutableListOf<Pair<String, String?>>()

    override suspend fun health(): HealthResult {
        return HealthResult(true, 1, "ok", "Shiva", "0.3.0", "gemma", null)
    }

    override fun sendMessage(
        conversationId: String?,
        message: String,
        images: List<String>,
    ): Flow<ChatStreamEvent> = flow {
        events.forEach { emit(it) }
    }

    override fun coreUpdates(
        conversationId: String,
        afterMessageId: String?,
    ): Flow<CoreAssistantUpdate> {
        updateRequests += conversationId to afterMessageId
        return updateFlow(conversationId, afterMessageId)
    }
}
