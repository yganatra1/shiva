package com.shiva.assistant.device.automation

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import androidx.core.content.getSystemService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * [UiEngine] backed by the live [ShivaAccessibilityService][com.shiva.assistant.device.accessibility.ShivaAccessibilityService].
 *
 * Every action tries the semantic accessibility action first and falls back to a synthesised
 * gesture. The fallback matters on Flutter and React Native screens, which frequently expose
 * nodes that report the right bounds but refuse ACTION_CLICK.
 */
class AccessibilityUiEngine : UiEngine {

    override fun isAvailable(): Boolean = AccessibilityEngineHolder.isConnected()

    override suspend fun inspect(
        maxNodes: Int,
        verbose: Boolean,
        includeInvisible: Boolean,
    ): UiOutcome<UiScreen> = withContext(Dispatchers.Main) {
        val service = AccessibilityEngineHolder.current() ?: return@withContext UiOutcome.ServiceUnavailable
        val root = service.rootInActiveWindow
            ?: return@withContext UiOutcome.Failed("No active window is currently readable.")
        val collection = UiTreeSnapshotter.collect(
            root = root,
            maxNodes = maxNodes.coerceIn(20, 1_200),
            includeInvisible = includeInvisible,
        )
        val all = collection.nodes.map { it.node }
        val visible = if (verbose) all else all.meaningfulOnly()
        UiOutcome.Success(
            UiScreen(
                packageName = root.packageName?.toString(),
                windowClass = AccessibilityEngineHolder.state.value.foregroundWindowClass,
                nodeCount = visible.size,
                truncated = collection.truncated,
                nodes = visible,
            ),
        )
    }

    override suspend fun find(selector: UiSelector, limit: Int): UiOutcome<UiMatches> =
        withContext(Dispatchers.Main) {
            val service = AccessibilityEngineHolder.current()
                ?: return@withContext UiOutcome.ServiceUnavailable
            if (selector.isEmpty) return@withContext emptySelector()
            val matches = collectForActions(service).selectAll(selector).map { it.node }
            UiOutcome.Success(UiMatches(matches.size, matches.take(limit.coerceIn(1, 100))))
        }

    override suspend fun click(
        selector: UiSelector,
        timeoutMs: Long,
        longPress: Boolean,
    ): UiOutcome<UiActionInfo> = withContext(Dispatchers.Main) {
        val service = AccessibilityEngineHolder.current() ?: return@withContext UiOutcome.ServiceUnavailable
        if (selector.isEmpty) return@withContext emptySelector()
        val target = awaitNode(service, selector, timeoutMs)
            ?: return@withContext notFound(selector)

        val action = if (longPress) {
            AccessibilityNodeInfo.ACTION_LONG_CLICK
        } else {
            AccessibilityNodeInfo.ACTION_CLICK
        }
        val label = if (longPress) "longPress" else "click"
        val semantic = performOnSelfOrAncestor(target.info, action) {
            if (longPress) it.isLongClickable else it.isClickable
        }
        if (semantic) {
            return@withContext UiOutcome.Success(UiActionInfo(label, "accessibility_action", target.node))
        }

        val bounds = target.node.bounds
        if (bounds.isEmpty) {
            return@withContext UiOutcome.Failed("Matched element has no tappable bounds on screen.")
        }
        val dispatched = dispatchGesture(
            service,
            tapPath(bounds.centerX, bounds.centerY),
            durationMs = if (longPress) LONG_PRESS_MS else TAP_MS,
        )
        if (dispatched) {
            UiOutcome.Success(UiActionInfo(label, "gesture", target.node))
        } else {
            UiOutcome.Failed("Neither the accessibility action nor a synthesised tap was accepted.")
        }
    }

    override suspend fun type(
        selector: UiSelector,
        text: String,
        clear: Boolean,
        timeoutMs: Long,
    ): UiOutcome<UiActionInfo> = withContext(Dispatchers.Main) {
        val service = AccessibilityEngineHolder.current() ?: return@withContext UiOutcome.ServiceUnavailable
        val target = if (selector.isEmpty) {
            service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { focused ->
                LiveNode(focused.toShallowUiNode(), focused)
            } ?: return@withContext UiOutcome.NotFound(
                "No text field is focused and no selector was supplied.",
            )
        } else {
            awaitNode(service, selector, timeoutMs) ?: return@withContext notFound(selector)
        }

        val info = target.info
        runCatching { info.refresh() }
        runCatching { info.performAction(AccessibilityNodeInfo.ACTION_FOCUS) }

        val existing = if (clear) "" else info.text?.toString().orEmpty()
        val bundle = Bundle().apply {
            putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                existing + text,
            )
        }
        val didSet = runCatching {
            info.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
        }.getOrDefault(false)
        if (didSet) {
            return@withContext UiOutcome.Success(UiActionInfo("type", "set_text", target.node))
        }

        val pasted = pasteViaClipboard(service, info, text)
        if (pasted) {
            UiOutcome.Success(UiActionInfo("type", "clipboard_paste", target.node))
        } else {
            UiOutcome.Failed("The matched element did not accept text input.")
        }
    }

    override suspend fun scroll(
        selector: UiSelector,
        direction: ScrollDirection,
        timeoutMs: Long,
    ): UiOutcome<UiActionInfo> = withContext(Dispatchers.Main) {
        val service = AccessibilityEngineHolder.current() ?: return@withContext UiOutcome.ServiceUnavailable
        val target = if (selector.isEmpty) {
            collectForActions(service).nodes.firstOrNull { it.node.scrollable }
        } else {
            awaitNode(service, selector, timeoutMs)
        }

        if (target != null) {
            val actionId = scrollActionId(direction)
            if (performOnSelfOrAncestor(target.info, actionId) { it.isScrollable }) {
                return@withContext UiOutcome.Success(
                    UiActionInfo("scroll", "accessibility_action", target.node),
                )
            }
        }

        val bounds = target?.node?.bounds?.takeIf { !it.isEmpty } ?: screenBounds(service)
        val swiped = dispatchGesture(service, swipePath(bounds, direction), SWIPE_MS)
        if (swiped) {
            UiOutcome.Success(UiActionInfo("scroll", "gesture", target?.node))
        } else if (target == null) {
            UiOutcome.NotFound("No scrollable element was found on the current screen.")
        } else {
            UiOutcome.Failed("The matched element could not be scrolled.")
        }
    }

    override suspend fun waitFor(
        selector: UiSelector,
        timeoutMs: Long,
        requireGone: Boolean,
    ): UiOutcome<UiActionInfo> = withContext(Dispatchers.Main) {
        val service = AccessibilityEngineHolder.current() ?: return@withContext UiOutcome.ServiceUnavailable
        if (selector.isEmpty) return@withContext emptySelector()
        pollFor(service, selector, timeoutMs, requireGone)
    }

    private suspend fun pollFor(
        service: AccessibilityService,
        selector: UiSelector,
        timeoutMs: Long,
        requireGone: Boolean,
    ): UiOutcome<UiActionInfo> {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val found = collectForActions(service).select(selector)
            if (requireGone && found == null) {
                return UiOutcome.Success(UiActionInfo("wait", "disappeared", null))
            }
            if (!requireGone && found != null) {
                return UiOutcome.Success(UiActionInfo("wait", "appeared", found.node))
            }
            if (SystemClock.uptimeMillis() >= deadline) {
                return UiOutcome.NotFound(
                    if (requireGone) {
                        "Element matching ${selector.describe()} was still present after ${timeoutMs}ms."
                    } else {
                        "Element matching ${selector.describe()} did not appear within ${timeoutMs}ms."
                    },
                )
            }
            delay(POLL_INTERVAL_MS)
        }
    }

    override suspend fun globalAction(action: GlobalUiAction): UiOutcome<UiActionInfo> =
        withContext(Dispatchers.Main) {
            val service = AccessibilityEngineHolder.current()
                ?: return@withContext UiOutcome.ServiceUnavailable
            val id = when (action) {
                GlobalUiAction.BACK -> AccessibilityService.GLOBAL_ACTION_BACK
                GlobalUiAction.HOME -> AccessibilityService.GLOBAL_ACTION_HOME
                GlobalUiAction.RECENTS -> AccessibilityService.GLOBAL_ACTION_RECENTS
                GlobalUiAction.NOTIFICATIONS -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
                GlobalUiAction.QUICK_SETTINGS -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
                GlobalUiAction.LOCK_SCREEN -> {
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                        return@withContext UiOutcome.Unsupported(
                            "Locking the screen requires Android 9 or newer.",
                        )
                    }
                    AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN
                }
            }
            if (service.performGlobalAction(id)) {
                UiOutcome.Success(UiActionInfo(action.name.lowercase(), "global_action", null))
            } else {
                UiOutcome.Failed("Android rejected the ${action.name.lowercase()} action.")
            }
        }

    override suspend fun screenshot(maxEdgePx: Int): UiOutcome<UiScreenshot> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return UiOutcome.Unsupported("Accessibility screenshots require Android 11 or newer.")
        }
        val service = AccessibilityEngineHolder.current() ?: return UiOutcome.ServiceUnavailable
        val bitmap = captureBitmap(service)
            ?: return UiOutcome.Failed(
                "The screenshot was refused. Secure screens block capture, and Android rate limits " +
                    "this to roughly one screenshot per second.",
            )
        return try {
            ScreenshotEncoder.encode(bitmap, maxEdgePx)
                ?.let { UiOutcome.Success(it) }
                ?: UiOutcome.Failed("The screenshot could not be compressed within the size budget.")
        } finally {
            bitmap.recycle()
        }
    }

    override suspend fun gesture(spec: GestureSpec): UiOutcome<UiActionInfo> =
        withContext(Dispatchers.Main) {
            val service = AccessibilityEngineHolder.current()
                ?: return@withContext UiOutcome.ServiceUnavailable
            val path = when (spec.kind) {
                GestureKind.TAP, GestureKind.LONG_PRESS -> tapPath(spec.startX, spec.startY)
                GestureKind.SWIPE -> Path().apply {
                    moveTo(spec.startX.toFloat(), spec.startY.toFloat())
                    lineTo(spec.endX.toFloat(), spec.endY.toFloat())
                }
            }
            val duration = when (spec.kind) {
                GestureKind.TAP -> TAP_MS
                GestureKind.LONG_PRESS -> LONG_PRESS_MS
                GestureKind.SWIPE -> spec.durationMs.coerceIn(50, 5_000)
            }
            if (dispatchGesture(service, path, duration)) {
                UiOutcome.Success(UiActionInfo(spec.kind.name.lowercase(), "gesture", null))
            } else {
                UiOutcome.Failed("Android did not accept the gesture.")
            }
        }

    // region internals

    private fun collectForActions(service: AccessibilityService): UiTreeCollection =
        UiTreeSnapshotter.collect(service.rootInActiveWindow, maxNodes = ACTION_MAX_NODES)

    private suspend fun awaitNode(
        service: AccessibilityService,
        selector: UiSelector,
        timeoutMs: Long,
    ): LiveNode? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            collectForActions(service).select(selector)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            delay(POLL_INTERVAL_MS)
        }
    }

    private fun performOnSelfOrAncestor(
        start: AccessibilityNodeInfo,
        action: Int,
        predicate: (AccessibilityNodeInfo) -> Boolean,
    ): Boolean {
        var current: AccessibilityNodeInfo? = start
        var hops = 0
        while (current != null && hops <= MAX_ANCESTOR_HOPS) {
            val node = current
            runCatching { node.refresh() }
            val accepted = predicate(node) &&
                runCatching { node.performAction(action) }.getOrDefault(false)
            if (accepted) return true
            current = runCatching { node.parent }.getOrNull()
            hops++
        }
        return false
    }

    private fun pasteViaClipboard(
        service: AccessibilityService,
        info: AccessibilityNodeInfo,
        text: String,
    ): Boolean {
        val clipboard = service.getSystemService<ClipboardManager>() ?: return false
        return runCatching {
            clipboard.setPrimaryClip(ClipData.newPlainText("shiva", text))
            info.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        }.getOrDefault(false)
    }

    private fun scrollActionId(direction: ScrollDirection): Int {
        val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        return when (direction) {
            ScrollDirection.FORWARD -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            ScrollDirection.BACKWARD -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            ScrollDirection.DOWN -> if (modern) {
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
            } else {
                AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            }
            ScrollDirection.UP -> if (modern) {
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
            } else {
                AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            }
            ScrollDirection.LEFT -> if (modern) {
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
            } else {
                AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            }
            ScrollDirection.RIGHT -> if (modern) {
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
            } else {
                AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            }
        }
    }

    private fun screenBounds(service: AccessibilityService): UiBounds {
        val metrics = service.resources.displayMetrics
        return UiBounds(0, 0, metrics.widthPixels, metrics.heightPixels)
    }

    private fun tapPath(x: Int, y: Int): Path = Path().apply {
        moveTo(x.toFloat(), y.toFloat())
        lineTo(x.toFloat() + 1f, y.toFloat() + 1f)
    }

    /**
     * A swipe that moves content in [direction] has to travel the opposite way with the finger:
     * dragging up reveals what is below.
     */
    private fun swipePath(bounds: UiBounds, direction: ScrollDirection): Path {
        val insetX = (bounds.width * 0.2f).toInt().coerceAtLeast(1)
        val insetY = (bounds.height * 0.2f).toInt().coerceAtLeast(1)
        val cx = bounds.centerX.toFloat()
        val cy = bounds.centerY.toFloat()
        val top = (bounds.top + insetY).toFloat()
        val bottom = (bounds.bottom - insetY).toFloat()
        val left = (bounds.left + insetX).toFloat()
        val right = (bounds.right - insetX).toFloat()
        return Path().apply {
            when (direction) {
                ScrollDirection.FORWARD, ScrollDirection.DOWN -> {
                    moveTo(cx, bottom)
                    lineTo(cx, top)
                }
                ScrollDirection.BACKWARD, ScrollDirection.UP -> {
                    moveTo(cx, top)
                    lineTo(cx, bottom)
                }
                ScrollDirection.LEFT -> {
                    moveTo(left, cy)
                    lineTo(right, cy)
                }
                ScrollDirection.RIGHT -> {
                    moveTo(right, cy)
                    lineTo(left, cy)
                }
            }
        }
    }

    private suspend fun dispatchGesture(
        service: AccessibilityService,
        path: Path,
        durationMs: Long,
    ): Boolean = suspendCancellableCoroutine { continuation ->
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        val callback = object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(description: GestureDescription?) {
                if (continuation.isActive) continuation.resume(true)
            }

            override fun onCancelled(description: GestureDescription?) {
                if (continuation.isActive) continuation.resume(false)
            }
        }
        val started = runCatching {
            service.dispatchGesture(gesture, callback, null)
        }.getOrDefault(false)
        if (!started && continuation.isActive) continuation.resume(false)
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun captureBitmap(service: AccessibilityService): Bitmap? {
        val result = suspendCancellableCoroutine<AccessibilityService.ScreenshotResult?> { continuation ->
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                service.mainExecutor,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                        if (continuation.isActive) continuation.resume(screenshot)
                    }

                    override fun onFailure(errorCode: Int) {
                        if (continuation.isActive) continuation.resume(null)
                    }
                },
            )
        } ?: return null

        val buffer = result.hardwareBuffer
        return try {
            val hardware = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
            val software = hardware?.copy(Bitmap.Config.ARGB_8888, false)
            hardware?.recycle()
            software
        } finally {
            buffer.close()
        }
    }

    private fun AccessibilityNodeInfo.toShallowUiNode(): UiNode = UiNode(
        ref = "focused",
        className = className?.toString(),
        packageName = packageName?.toString(),
        viewId = viewIdResourceName,
        text = text?.toString(),
        description = contentDescription?.toString(),
        bounds = UiBounds(0, 0, 0, 0),
        editable = isEditable,
        focused = true,
    )

    private fun emptySelector(): UiOutcome<Nothing> = UiOutcome.Failed(
        "A selector is required. Provide text, viewId, description, or className.",
    )

    private fun notFound(selector: UiSelector): UiOutcome<Nothing> =
        UiOutcome.NotFound("No element matched ${selector.describe()}.")

    // endregion

    private companion object {
        const val POLL_INTERVAL_MS = 150L
        const val MAX_ANCESTOR_HOPS = 6
        const val ACTION_MAX_NODES = 1_200
        const val TAP_MS = 60L
        const val LONG_PRESS_MS = 600L
        const val SWIPE_MS = 300L
    }
}
