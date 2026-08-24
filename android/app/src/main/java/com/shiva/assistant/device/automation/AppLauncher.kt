package com.shiva.assistant.device.automation

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

sealed interface AppLaunchResult {
    data class Started(val app: InstalledApp) : AppLaunchResult
    data class NotFound(val target: String) : AppLaunchResult
    data class Failed(val reason: String) : AppLaunchResult
}

/**
 * Resolves and starts other apps.
 *
 * Android 11+ hides installed packages unless the app declares what it needs to see, so the
 * manifest declares a MAIN/LAUNCHER `<queries>` intent. That reveals every app with a launcher
 * icon, which is exactly the set worth opening, without requesting QUERY_ALL_PACKAGES.
 */
class AppLauncher(
    context: Context,
) {
    private val appContext = context.applicationContext
    private val packageManager: PackageManager get() = appContext.packageManager

    fun installedApps(query: String? = null, limit: Int = 100): List<InstalledApp> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = runCatching {
            packageManager.queryIntentActivities(intent, 0)
        }.getOrDefault(emptyList())
        val needle = query?.trim()?.takeIf { it.isNotEmpty() }
        return resolved
            .asSequence()
            .mapNotNull { info ->
                val packageName = info.activityInfo?.packageName ?: return@mapNotNull null
                val label = runCatching { info.loadLabel(packageManager).toString() }
                    .getOrNull()
                    ?.takeIf { it.isNotBlank() }
                    ?: packageName
                InstalledApp(packageName = packageName, label = label)
            }
            .distinctBy { it.packageName }
            .filter { app ->
                needle == null ||
                    app.label.contains(needle, ignoreCase = true) ||
                    app.packageName.contains(needle, ignoreCase = true)
            }
            .sortedBy { it.label.lowercase() }
            .take(limit.coerceIn(1, 300))
            .toList()
    }

    /** Accepts either a package name or a user-visible app label such as "Zepto". */
    fun resolve(target: String): InstalledApp? {
        val needle = target.trim()
        if (needle.isEmpty()) return null
        val apps = installedApps(limit = 300)
        return apps.firstOrNull { it.packageName.equals(needle, ignoreCase = true) }
            ?: apps.firstOrNull { it.label.equals(needle, ignoreCase = true) }
            ?: apps.firstOrNull { it.label.startsWith(needle, ignoreCase = true) }
            ?: apps.firstOrNull { it.label.contains(needle, ignoreCase = true) }
            ?: apps.firstOrNull { it.packageName.contains(needle, ignoreCase = true) }
    }

    fun launch(target: String): AppLaunchResult {
        val app = resolve(target) ?: return AppLaunchResult.NotFound(target)
        val intent = packageManager.getLaunchIntentForPackage(app.packageName)
            ?: return AppLaunchResult.Failed("${app.label} does not expose a launchable screen.")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        return runCatching {
            appContext.startActivity(intent)
            AppLaunchResult.Started(app)
        }.getOrElse { error ->
            AppLaunchResult.Failed(error.message ?: "Android refused to start ${app.label}.")
        }
    }
}
