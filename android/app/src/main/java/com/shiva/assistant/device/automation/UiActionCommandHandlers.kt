package com.shiva.assistant.device.automation

import com.shiva.assistant.device.automation.UiCommandArgs.bool
import com.shiva.assistant.device.automation.UiCommandArgs.int
import com.shiva.assistant.device.automation.UiCommandArgs.long
import com.shiva.assistant.device.automation.UiCommandArgs.string
import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus

class UiClickCommandHandler(
    private val engine: UiEngine,
) : DeviceCommandHandler {
    override val type: String = "device.ui.click"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val outcome = engine.click(
            selector = UiCommandArgs.selector(command.arguments),
            timeoutMs = UiCommandArgs.timeout(command.arguments, UiCommandArgs.DEFAULT_ACTION_WAIT_MS),
            longPress = command.arguments.bool("longPress") ?: false,
        )
        return outcome.toDeviceResult(command.id) { it.toResultMap() }
    }
}

class UiTypeCommandHandler(
    private val engine: UiEngine,
) : DeviceCommandHandler {
    override val type: String = "device.ui.type"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val text = command.arguments["text"]
            ?: return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "A 'text' argument is required.",
            )
        val outcome = engine.type(
            selector = UiCommandArgs.selector(command.arguments),
            text = text,
            clear = command.arguments.bool("clear") ?: true,
            timeoutMs = UiCommandArgs.timeout(command.arguments, UiCommandArgs.DEFAULT_ACTION_WAIT_MS),
        )
        return outcome.toDeviceResult(command.id) { it.toResultMap() }
    }
}

class UiScrollCommandHandler(
    private val engine: UiEngine,
) : DeviceCommandHandler {
    override val type: String = "device.ui.scroll"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val outcome = engine.scroll(
            selector = UiCommandArgs.selector(command.arguments),
            direction = UiCommandArgs.scrollDirection(command.arguments.string("direction")),
            timeoutMs = UiCommandArgs.timeout(command.arguments, UiCommandArgs.DEFAULT_ACTION_WAIT_MS),
        )
        return outcome.toDeviceResult(command.id) { it.toResultMap() }
    }
}

class UiWaitCommandHandler(
    private val engine: UiEngine,
) : DeviceCommandHandler {
    override val type: String = "device.ui.wait"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val outcome = engine.waitFor(
            selector = UiCommandArgs.selector(command.arguments),
            timeoutMs = UiCommandArgs.timeout(command.arguments, UiCommandArgs.DEFAULT_EXPLICIT_WAIT_MS),
            requireGone = command.arguments.bool("requireGone") ?: false,
        )
        return outcome.toDeviceResult(command.id) { it.toResultMap() }
    }
}

/**
 * Backs both `device.ui.back` (fixed action) and `device.ui.global` (action chosen by argument).
 */
class UiGlobalActionCommandHandler(
    override val type: String,
    private val engine: UiEngine,
    private val fixedAction: GlobalUiAction? = null,
) : DeviceCommandHandler {

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val action = fixedAction
            ?: UiCommandArgs.globalAction(command.arguments.string("action"))
            ?: return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "Unknown action. Use back, home, recents, notifications, quick_settings, or lock.",
            )
        return engine.globalAction(action).toDeviceResult(command.id) { it.toResultMap() }
    }
}

class UiGestureCommandHandler(
    private val engine: UiEngine,
) : DeviceCommandHandler {
    override val type: String = "device.ui.gesture"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val kind = when (command.arguments.string("kind")?.lowercase()) {
            "swipe" -> GestureKind.SWIPE
            "long_press", "longpress" -> GestureKind.LONG_PRESS
            else -> GestureKind.TAP
        }
        val startX = command.arguments.int("x")
        val startY = command.arguments.int("y")
        if (startX == null || startY == null) {
            return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "Arguments 'x' and 'y' are required.",
            )
        }
        val spec = GestureSpec(
            kind = kind,
            startX = startX,
            startY = startY,
            endX = command.arguments.int("toX") ?: startX,
            endY = command.arguments.int("toY") ?: startY,
            durationMs = command.arguments.long("durationMs") ?: 120L,
        )
        return engine.gesture(spec).toDeviceResult(command.id) { it.toResultMap() }
    }
}
