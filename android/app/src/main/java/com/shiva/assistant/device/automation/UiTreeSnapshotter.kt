package com.shiva.assistant.device.automation

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

internal data class LiveNode(
    val node: UiNode,
    val info: AccessibilityNodeInfo,
)

internal data class UiTreeCollection(
    val nodes: List<LiveNode>,
    val truncated: Boolean,
) {
    fun select(selector: UiSelector): LiveNode? {
        if (selector.isEmpty) return null
        val matches = nodes.filter { selector.matches(it.node) }
        return matches.getOrNull(selector.index)
    }

    fun selectAll(selector: UiSelector): List<LiveNode> =
        if (selector.isEmpty) emptyList() else nodes.filter { selector.matches(it.node) }
}

/**
 * Flattens the live accessibility tree into transportable [UiNode]s.
 *
 * Nodes are kept in depth-first order so that "index" in a selector means the same thing the
 * user would count on screen, top to bottom.
 */
internal object UiTreeSnapshotter {
    fun collect(
        root: AccessibilityNodeInfo?,
        maxNodes: Int = UiDefaults.MAX_NODES,
        maxDepth: Int = UiDefaults.MAX_DEPTH,
        includeInvisible: Boolean = false,
    ): UiTreeCollection {
        if (root == null) return UiTreeCollection(emptyList(), truncated = false)
        val out = ArrayList<LiveNode>(minOf(maxNodes, 128))
        val truncated = !walk(
            info = root,
            ref = "0",
            depth = 0,
            out = out,
            maxNodes = maxNodes,
            maxDepth = maxDepth,
            includeInvisible = includeInvisible,
        )
        return UiTreeCollection(out, truncated)
    }

    /** Returns false when the traversal hit [maxNodes] and stopped early. */
    private fun walk(
        info: AccessibilityNodeInfo,
        ref: String,
        depth: Int,
        out: MutableList<LiveNode>,
        maxNodes: Int,
        maxDepth: Int,
        includeInvisible: Boolean,
    ): Boolean {
        if (out.size >= maxNodes) return false
        val bounds = info.screenBounds()
        val visible = info.isVisibleToUser && !bounds.isEmpty
        if (visible || includeInvisible) {
            out.add(LiveNode(info.toUiNode(ref, bounds), info))
        }
        if (depth >= maxDepth) return true
        for (index in 0 until info.childCount) {
            val child = runCatching { info.getChild(index) }.getOrNull() ?: continue
            val completed = walk(
                info = child,
                ref = "$ref.$index",
                depth = depth + 1,
                out = out,
                maxNodes = maxNodes,
                maxDepth = maxDepth,
                includeInvisible = includeInvisible,
            )
            if (!completed) return false
        }
        return true
    }

    private fun AccessibilityNodeInfo.screenBounds(): UiBounds {
        val rect = Rect()
        getBoundsInScreen(rect)
        return UiBounds(rect.left, rect.top, rect.right, rect.bottom)
    }

    private fun AccessibilityNodeInfo.toUiNode(ref: String, bounds: UiBounds): UiNode = UiNode(
        ref = ref,
        className = className?.toString(),
        packageName = packageName?.toString(),
        viewId = viewIdResourceName,
        text = text?.toString()?.trim()?.takeIf { it.isNotEmpty() },
        description = contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() },
        bounds = bounds,
        clickable = isClickable,
        editable = isEditable,
        scrollable = isScrollable,
        checkable = isCheckable,
        checked = isChecked,
        enabled = isEnabled,
        focused = isFocused,
    )
}

/**
 * Drops structural padding views that carry no label and cannot be acted on. Without this an
 * inspect of a typical shopping app returns hundreds of anonymous containers.
 */
internal fun List<UiNode>.meaningfulOnly(): List<UiNode> = filter { it.hasContent || it.isInteractive }
