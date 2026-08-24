package com.shiva.assistant.device.automation

import com.shiva.assistant.core.network.ShivaJson
import com.shiva.assistant.device.automation.UiCommandArgs.bool
import com.shiva.assistant.device.automation.UiCommandArgs.int
import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import kotlinx.serialization.encodeToString

class UiInspectCommandHandler(
    private val engine: UiEngine,
) : DeviceCommandHandler {
    override val type: String = "device.ui.inspect"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val outcome = engine.inspect(
            maxNodes = command.arguments.int("maxNodes") ?: UiDefaults.MAX_NODES,
            verbose = command.arguments.bool("verbose") ?: false,
            includeInvisible = command.arguments.bool("includeInvisible") ?: false,
        )
        return outcome.toDeviceResult(command.id) { screen ->
            buildMap {
                screen.packageName?.let { put("package", it) }
                screen.windowClass?.let { put("windowClass", it) }
                put("nodeCount", screen.nodeCount.toString())
                put("truncated", screen.truncated.toString())
                put("screen", ShivaJson.encodeToString(screen))
            }
        }
    }
}

class UiFindCommandHandler(
    private val engine: UiEngine,
) : DeviceCommandHandler {
    override val type: String = "device.ui.find"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val outcome = engine.find(
            selector = UiCommandArgs.selector(command.arguments),
            limit = command.arguments.int("limit") ?: UiDefaults.FIND_LIMIT,
        )
        return outcome.toDeviceResult(command.id) { matches ->
            mapOf(
                "count" to matches.count.toString(),
                "nodes" to ShivaJson.encodeToString(matches.nodes),
            )
        }
    }
}

class UiScreenshotCommandHandler(
    private val engine: UiEngine,
) : DeviceCommandHandler {
    override val type: String = "device.ui.screenshot"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val outcome = engine.screenshot(
            maxEdgePx = command.arguments.int("maxEdgePx") ?: UiDefaults.SCREENSHOT_MAX_EDGE_PX,
        )
        return outcome.toDeviceResult(command.id) { shot ->
            mapOf(
                "mime" to "image/jpeg",
                "encoding" to "base64",
                "width" to shot.width.toString(),
                "height" to shot.height.toString(),
                "data" to shot.base64Jpeg,
            )
        }
    }
}
