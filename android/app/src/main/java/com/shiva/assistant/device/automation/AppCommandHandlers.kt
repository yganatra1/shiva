package com.shiva.assistant.device.automation

import com.shiva.assistant.core.network.ShivaJson
import com.shiva.assistant.device.automation.UiCommandArgs.int
import com.shiva.assistant.device.automation.UiCommandArgs.string
import com.shiva.assistant.device.command.DeviceCommand
import com.shiva.assistant.device.command.DeviceCommandHandler
import com.shiva.assistant.device.command.DeviceCommandResult
import com.shiva.assistant.device.command.DeviceCommandStatus
import kotlinx.serialization.encodeToString

class AppOpenCommandHandler(
    private val launcher: AppLauncher,
) : DeviceCommandHandler {
    override val type: String = "device.app.open"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val target = command.arguments.string("package")
            ?: command.arguments.string("name")
            ?: command.arguments.string("app")
            ?: return DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "A 'package' or 'name' argument is required.",
            )
        return when (val outcome = launcher.launch(target)) {
            is AppLaunchResult.Started -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.COMPLETED,
                result = mapOf(
                    "package" to outcome.app.packageName,
                    "label" to outcome.app.label,
                ),
            )
            is AppLaunchResult.NotFound -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = "No installed app matched \"${outcome.target}\".",
            )
            is AppLaunchResult.Failed -> DeviceCommandResult(
                commandId = command.id,
                status = DeviceCommandStatus.FAILED,
                error = outcome.reason,
            )
        }
    }
}

class AppListCommandHandler(
    private val launcher: AppLauncher,
) : DeviceCommandHandler {
    override val type: String = "device.app.list"

    override suspend fun handle(command: DeviceCommand): DeviceCommandResult {
        val apps = launcher.installedApps(
            query = command.arguments.string("query"),
            limit = command.arguments.int("limit") ?: 100,
        )
        return DeviceCommandResult(
            commandId = command.id,
            status = DeviceCommandStatus.COMPLETED,
            result = mapOf(
                "count" to apps.size.toString(),
                "apps" to ShivaJson.encodeToString(apps),
            ),
        )
    }
}
