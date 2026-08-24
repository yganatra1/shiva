package com.shiva.assistant.device.capability

import android.app.role.RoleManager
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi

internal class RoleSupport(
    private val context: Context,
) {
    fun sms(): RoleSnapshot {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return RoleSnapshot(available = false, held = false, supportedOnThisSdk = false)
        }
        return snapshotSms()
    }

    fun assistant(): RoleSnapshot {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return RoleSnapshot(available = false, held = false, supportedOnThisSdk = false)
        }
        return snapshotAssistant()
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun snapshotSms(): RoleSnapshot = snapshot(RoleManager.ROLE_SMS)

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun snapshotAssistant(): RoleSnapshot = snapshot(RoleManager.ROLE_ASSISTANT)

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun snapshot(role: String): RoleSnapshot {
        val manager = context.getSystemService(RoleManager::class.java)
            ?: return RoleSnapshot(available = false, held = false, supportedOnThisSdk = true)
        return RoleSnapshot(
            available = manager.isRoleAvailable(role),
            held = manager.isRoleHeld(role),
            supportedOnThisSdk = true,
        )
    }
}

internal data class RoleSnapshot(
    val available: Boolean,
    val held: Boolean,
    val supportedOnThisSdk: Boolean,
)
