package com.shiva.assistant.device.automation

import kotlinx.serialization.Serializable

@Serializable
data class UiBounds(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
) {
    val centerX: Int get() = (left + right) / 2
    val centerY: Int get() = (top + bottom) / 2
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val isEmpty: Boolean get() = width <= 0 || height <= 0
}

/**
 * One element of the on-screen accessibility tree, flattened for transport.
 *
 * [ref] is a positional path such as "0.3.1" and is only stable for as long as the screen
 * does not change, so it is meant for reading and for describing a screen to the server.
 * Actions always re-resolve a live node from a [UiSelector] instead of trusting a ref.
 */
@Serializable
data class UiNode(
    val ref: String,
    val className: String? = null,
    val packageName: String? = null,
    val viewId: String? = null,
    val text: String? = null,
    val description: String? = null,
    val bounds: UiBounds,
    val clickable: Boolean = false,
    val editable: Boolean = false,
    val scrollable: Boolean = false,
    val checkable: Boolean = false,
    val checked: Boolean = false,
    val enabled: Boolean = true,
    val focused: Boolean = false,
) {
    val hasContent: Boolean
        get() = !text.isNullOrBlank() || !description.isNullOrBlank() || !viewId.isNullOrBlank()

    val isInteractive: Boolean
        get() = clickable || editable || scrollable || checkable
}

@Serializable
data class UiScreen(
    val packageName: String? = null,
    val windowClass: String? = null,
    val nodeCount: Int,
    val truncated: Boolean = false,
    val nodes: List<UiNode>,
)

@Serializable
data class UiMatches(
    val count: Int,
    val nodes: List<UiNode>,
)

@Serializable
data class UiActionInfo(
    val action: String,
    val strategy: String,
    val node: UiNode? = null,
)

@Serializable
data class UiScreenshot(
    val base64Jpeg: String,
    val width: Int,
    val height: Int,
)

@Serializable
data class InstalledApp(
    val packageName: String,
    val label: String,
)

enum class ScrollDirection {
    FORWARD,
    BACKWARD,
    UP,
    DOWN,
    LEFT,
    RIGHT,
}

enum class GlobalUiAction {
    BACK,
    HOME,
    RECENTS,
    NOTIFICATIONS,
    QUICK_SETTINGS,
    LOCK_SCREEN,
}

/**
 * Outcome of an automation call. Each variant maps onto a device command status so handlers
 * do not have to invent their own error taxonomy.
 */
sealed interface UiOutcome<out T> {
    data class Success<T>(val value: T) : UiOutcome<T>

    /** The accessibility service is not enabled or not currently bound. */
    data object ServiceUnavailable : UiOutcome<Nothing>

    data class NotFound(val detail: String) : UiOutcome<Nothing>

    data class Failed(val reason: String) : UiOutcome<Nothing>

    data class Unsupported(val reason: String) : UiOutcome<Nothing>
}

/**
 * Element query. An empty selector matches nothing so that a malformed command never
 * resolves to an arbitrary element and clicks it.
 */
@Serializable
data class UiSelector(
    val text: String? = null,
    val textContains: String? = null,
    val viewId: String? = null,
    val description: String? = null,
    val descriptionContains: String? = null,
    val className: String? = null,
    val packageName: String? = null,
    val clickable: Boolean? = null,
    val editable: Boolean? = null,
    val scrollable: Boolean? = null,
    val index: Int = 0,
    val ignoreCase: Boolean = true,
) {
    val isEmpty: Boolean
        get() = text == null &&
            textContains == null &&
            viewId == null &&
            description == null &&
            descriptionContains == null &&
            className == null &&
            packageName == null &&
            clickable == null &&
            editable == null &&
            scrollable == null

    fun describe(): String {
        val parts = buildList {
            text?.let { add("text=$it") }
            textContains?.let { add("textContains=$it") }
            viewId?.let { add("viewId=$it") }
            description?.let { add("description=$it") }
            descriptionContains?.let { add("descriptionContains=$it") }
            className?.let { add("className=$it") }
            packageName?.let { add("packageName=$it") }
            clickable?.let { add("clickable=$it") }
            editable?.let { add("editable=$it") }
            scrollable?.let { add("scrollable=$it") }
            if (index != 0) add("index=$index")
        }
        return if (parts.isEmpty()) "<empty>" else parts.joinToString(", ")
    }
}

fun UiSelector.matches(node: UiNode): Boolean {
    if (isEmpty) return false
    if (text != null && !node.text.equalsOrNull(text, ignoreCase)) return false
    if (textContains != null && node.text?.contains(textContains, ignoreCase) != true) return false
    if (description != null && !node.description.equalsOrNull(description, ignoreCase)) return false
    if (descriptionContains != null &&
        node.description?.contains(descriptionContains, ignoreCase) != true
    ) {
        return false
    }
    if (viewId != null && !matchesViewId(node.viewId, viewId)) return false
    if (className != null && node.className?.contains(className, ignoreCase = true) != true) return false
    if (packageName != null && node.packageName != packageName) return false
    if (clickable != null && node.clickable != clickable) return false
    if (editable != null && node.editable != editable) return false
    if (scrollable != null && node.scrollable != scrollable) return false
    return true
}

/** Accepts either a fully qualified id ("com.app:id/search") or the bare name ("search"). */
private fun matchesViewId(actual: String?, wanted: String): Boolean {
    if (actual == null) return false
    if (actual.equals(wanted, ignoreCase = false)) return true
    return actual.endsWith("/$wanted")
}

private fun String?.equalsOrNull(other: String, ignoreCase: Boolean): Boolean {
    if (this == null) return false
    return this.trim().equals(other.trim(), ignoreCase)
}

/** Applies [selector] to [nodes] and returns matches ordered by tree position. */
fun List<UiNode>.selectAll(selector: UiSelector): List<UiNode> = filter { selector.matches(it) }
