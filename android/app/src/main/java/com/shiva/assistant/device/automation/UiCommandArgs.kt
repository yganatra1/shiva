package com.shiva.assistant.device.automation

import com.shiva.assistant.core.network.ShivaJson

/**
 * Device command arguments arrive as `Map<String, String>`, so a selector can be sent either
 * as one JSON blob under "selector" or as flat convenience keys for simple lookups.
 */
internal object UiCommandArgs {
    fun selector(arguments: Map<String, String>): UiSelector {
        arguments["selector"]?.takeIf { it.isNotBlank() }?.let { raw ->
            runCatching { ShivaJson.decodeFromString<UiSelector>(raw) }
                .getOrNull()
                ?.let { return it }
        }
        return UiSelector(
            text = arguments.string("text"),
            textContains = arguments.string("textContains"),
            viewId = arguments.string("viewId") ?: arguments.string("id"),
            description = arguments.string("description") ?: arguments.string("desc"),
            descriptionContains = arguments.string("descriptionContains"),
            className = arguments.string("className") ?: arguments.string("class"),
            packageName = arguments.string("packageName"),
            clickable = arguments.bool("clickable"),
            editable = arguments.bool("editable"),
            scrollable = arguments.bool("scrollable"),
            index = arguments.int("index") ?: 0,
            ignoreCase = arguments.bool("ignoreCase") ?: true,
        )
    }

    fun timeout(arguments: Map<String, String>, default: Long): Long =
        arguments.long("timeoutMs")?.coerceIn(0, MAX_WAIT_MS) ?: default

    fun scrollDirection(raw: String?): ScrollDirection = when (raw?.trim()?.lowercase()) {
        "backward", "back", "previous" -> ScrollDirection.BACKWARD
        "up" -> ScrollDirection.UP
        "down" -> ScrollDirection.DOWN
        "left" -> ScrollDirection.LEFT
        "right" -> ScrollDirection.RIGHT
        else -> ScrollDirection.FORWARD
    }

    fun globalAction(raw: String?): GlobalUiAction? = when (raw?.trim()?.lowercase()) {
        "back" -> GlobalUiAction.BACK
        "home" -> GlobalUiAction.HOME
        "recents", "recent", "overview" -> GlobalUiAction.RECENTS
        "notifications", "notification_shade" -> GlobalUiAction.NOTIFICATIONS
        "quick_settings", "quicksettings" -> GlobalUiAction.QUICK_SETTINGS
        "lock", "lock_screen" -> GlobalUiAction.LOCK_SCREEN
        else -> null
    }

    fun Map<String, String>.string(key: String): String? = this[key]?.takeIf { it.isNotBlank() }

    fun Map<String, String>.bool(key: String): Boolean? = when (this[key]?.trim()?.lowercase()) {
        "true", "1", "yes" -> true
        "false", "0", "no" -> false
        else -> null
    }

    fun Map<String, String>.int(key: String): Int? = this[key]?.trim()?.toIntOrNull()

    fun Map<String, String>.long(key: String): Long? = this[key]?.trim()?.toLongOrNull()

    const val MAX_WAIT_MS = 60_000L
    const val DEFAULT_ACTION_WAIT_MS = 4_000L
    const val DEFAULT_EXPLICIT_WAIT_MS = 10_000L
}
