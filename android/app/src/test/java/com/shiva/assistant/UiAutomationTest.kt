package com.shiva.assistant

import com.shiva.assistant.device.automation.GlobalUiAction
import com.shiva.assistant.device.automation.ScrollDirection
import com.shiva.assistant.device.automation.UiBounds
import com.shiva.assistant.device.automation.UiCommandArgs
import com.shiva.assistant.device.automation.UiNode
import com.shiva.assistant.device.automation.UiSelector
import com.shiva.assistant.device.automation.matches
import com.shiva.assistant.device.automation.meaningfulOnly
import com.shiva.assistant.device.automation.selectAll
import com.shiva.assistant.device.command.DeviceActivityLog
import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandRouter
import com.shiva.assistant.device.command.DeviceCommandStatus
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UiAutomationTest {

    private fun node(
        ref: String = "0",
        text: String? = null,
        viewId: String? = null,
        description: String? = null,
        className: String? = null,
        packageName: String? = null,
        clickable: Boolean = false,
        editable: Boolean = false,
        scrollable: Boolean = false,
    ) = UiNode(
        ref = ref,
        className = className,
        packageName = packageName,
        viewId = viewId,
        text = text,
        description = description,
        bounds = UiBounds(0, 0, 100, 40),
        clickable = clickable,
        editable = editable,
        scrollable = scrollable,
    )

    @Test
    fun `empty selector never matches`() {
        assertFalse(UiSelector().matches(node(text = "Add")))
    }

    @Test
    fun `text match ignores case and surrounding space by default`() {
        assertTrue(UiSelector(text = "add").matches(node(text = "  Add ")))
        assertFalse(UiSelector(text = "add", ignoreCase = false).matches(node(text = "Add")))
    }

    @Test
    fun `view id matches bare name or fully qualified id`() {
        val target = node(viewId = "com.zeptoconsumerapp:id/search_input")
        assertTrue(UiSelector(viewId = "search_input").matches(target))
        assertTrue(UiSelector(viewId = "com.zeptoconsumerapp:id/search_input").matches(target))
        assertFalse(UiSelector(viewId = "input").matches(target))
    }

    @Test
    fun `combined criteria must all hold`() {
        val selector = UiSelector(textContains = "Add", clickable = true)
        assertTrue(selector.matches(node(text = "Add to cart", clickable = true)))
        assertFalse(selector.matches(node(text = "Add to cart", clickable = false)))
        assertFalse(selector.matches(node(text = "Remove", clickable = true)))
    }

    @Test
    fun `index picks the nth match in tree order`() {
        val nodes = listOf(
            node(ref = "0.0", text = "Add", clickable = true),
            node(ref = "0.1", text = "Add", clickable = true),
            node(ref = "0.2", text = "Add", clickable = true),
        )
        val matches = nodes.selectAll(UiSelector(text = "Add"))
        assertEquals(3, matches.size)
        assertEquals("0.1", matches[1].ref)
    }

    @Test
    fun `package selector filters across apps`() {
        val selector = UiSelector(text = "OK", packageName = "com.android.systemui")
        assertTrue(selector.matches(node(text = "OK", packageName = "com.android.systemui")))
        assertFalse(selector.matches(node(text = "OK", packageName = "com.zeptoconsumerapp")))
    }

    @Test
    fun `meaningful filter drops anonymous containers but keeps interactive views`() {
        val nodes = listOf(
            node(ref = "0", className = "android.widget.FrameLayout"),
            node(ref = "0.0", text = "Milk"),
            node(ref = "0.1", className = "android.widget.ImageView", clickable = true),
            node(ref = "0.2", viewId = "com.app:id/cart"),
        )
        val kept = nodes.meaningfulOnly().map { it.ref }
        assertEquals(listOf("0.0", "0.1", "0.2"), kept)
    }

    @Test
    fun `scroll direction parsing falls back to forward`() {
        assertEquals(ScrollDirection.UP, UiCommandArgs.scrollDirection("up"))
        assertEquals(ScrollDirection.BACKWARD, UiCommandArgs.scrollDirection("Back"))
        assertEquals(ScrollDirection.FORWARD, UiCommandArgs.scrollDirection("nonsense"))
        assertEquals(ScrollDirection.FORWARD, UiCommandArgs.scrollDirection(null))
    }

    @Test
    fun `global action parsing accepts aliases and rejects unknown`() {
        assertEquals(GlobalUiAction.RECENTS, UiCommandArgs.globalAction("overview"))
        assertEquals(GlobalUiAction.LOCK_SCREEN, UiCommandArgs.globalAction("lock"))
        assertNull(UiCommandArgs.globalAction("explode"))
    }

    @Test
    fun `selector can arrive as json`() {
        val selector = UiCommandArgs.selector(
            mapOf("selector" to """{"textContains":"Add","clickable":true,"index":2}"""),
        )
        assertEquals("Add", selector.textContains)
        assertEquals(true, selector.clickable)
        assertEquals(2, selector.index)
    }

    @Test
    fun `selector falls back to flat arguments and aliases`() {
        val selector = UiCommandArgs.selector(
            mapOf("id" to "search_input", "desc" to "Search", "editable" to "true"),
        )
        assertEquals("search_input", selector.viewId)
        assertEquals("Search", selector.description)
        assertEquals(true, selector.editable)
    }

    @Test
    fun `malformed selector json falls back instead of throwing`() {
        val selector = UiCommandArgs.selector(mapOf("selector" to "{not json", "text" to "Cart"))
        assertEquals("Cart", selector.text)
    }

    @Test
    fun `timeout is clamped to the supported window`() {
        assertEquals(1_000L, UiCommandArgs.timeout(mapOf("timeoutMs" to "1000"), 4_000))
        assertEquals(
            UiCommandArgs.MAX_WAIT_MS,
            UiCommandArgs.timeout(mapOf("timeoutMs" to "999999"), 4_000),
        )
        assertEquals(4_000L, UiCommandArgs.timeout(emptyMap(), 4_000))
    }

    @Test
    fun `activity log records the most recent command first`() = runTest {
        val log = DeviceActivityLog(capacity = 2)
        val router = DeviceCommandRouter(
            handlers = listOf(
                handler("device.ui.click", DeviceCommandStatus.COMPLETED),
                handler("device.ui.type", DeviceCommandStatus.FAILED, "no field"),
            ),
            observer = log,
        )

        router.dispatch(command("a", "device.ui.click"))
        router.dispatch(command("b", "device.ui.type"))
        router.dispatch(command("c", "device.ui.nope"))

        val snapshot = log.state.value
        assertEquals(3, snapshot.handled)
        assertEquals(2, snapshot.recent.size)
        assertEquals("device.ui.nope", snapshot.last?.type)
        assertEquals(DeviceCommandStatus.UNSUPPORTED, snapshot.last?.status)
        assertEquals("device.ui.type", snapshot.recent[1].type)
        assertEquals("no field", snapshot.recent[1].error)
    }

    @Test
    fun `router exposes every registered automation type`() {
        val router = DeviceCommandRouter(
            handlers = listOf(
                handler("device.ui.click", DeviceCommandStatus.COMPLETED),
                handler("device.app.open", DeviceCommandStatus.COMPLETED),
            ),
        )
        assertEquals(setOf("device.ui.click", "device.app.open"), router.supportedTypes)
    }

    private fun command(id: String, type: String) = DeviceCommand(
        id = id,
        type = type,
        createdAtEpochMs = 0,
    )

    private fun handler(
        commandType: String,
        status: DeviceCommandStatus,
        error: String? = null,
    ) = object : DeviceCommandHandler {
        override val type: String = commandType
        override suspend fun handle(command: DeviceCommand) = DeviceCommandResult(
            commandId = command.id,
            status = status,
            error = error,
        )
    }
}
