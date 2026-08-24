package com.shiva.assistant.device.automation

enum class GestureKind {
    TAP,
    LONG_PRESS,
    SWIPE,
}

data class GestureSpec(
    val kind: GestureKind,
    val startX: Int,
    val startY: Int,
    val endX: Int = startX,
    val endY: Int = startY,
    val durationMs: Long = 120,
)

object UiDefaults {
    const val MAX_NODES = 400
    const val MAX_DEPTH = 40
    const val FIND_LIMIT = 20
    const val SCREENSHOT_MAX_EDGE_PX = 1080
}

/**
 * Generic on-screen automation. Every call resolves elements freshly from the live accessibility
 * tree, so callers can issue independent commands without holding node references between them.
 */
interface UiEngine {
    fun isAvailable(): Boolean

    suspend fun inspect(
        maxNodes: Int = UiDefaults.MAX_NODES,
        verbose: Boolean = false,
        includeInvisible: Boolean = false,
    ): UiOutcome<UiScreen>

    suspend fun find(selector: UiSelector, limit: Int = UiDefaults.FIND_LIMIT): UiOutcome<UiMatches>

    suspend fun click(
        selector: UiSelector,
        timeoutMs: Long,
        longPress: Boolean = false,
    ): UiOutcome<UiActionInfo>

    suspend fun type(
        selector: UiSelector,
        text: String,
        clear: Boolean,
        timeoutMs: Long,
    ): UiOutcome<UiActionInfo>

    suspend fun scroll(
        selector: UiSelector,
        direction: ScrollDirection,
        timeoutMs: Long,
    ): UiOutcome<UiActionInfo>

    suspend fun waitFor(
        selector: UiSelector,
        timeoutMs: Long,
        requireGone: Boolean = false,
    ): UiOutcome<UiActionInfo>

    suspend fun globalAction(action: GlobalUiAction): UiOutcome<UiActionInfo>

    suspend fun screenshot(maxEdgePx: Int = UiDefaults.SCREENSHOT_MAX_EDGE_PX): UiOutcome<UiScreenshot>

    suspend fun gesture(spec: GestureSpec): UiOutcome<UiActionInfo>
}
