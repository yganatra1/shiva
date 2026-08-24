package com.shiva.assistant.device.phone

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.ContextCompat
import com.shiva.assistant.core.logging.ShivaLog

class AndroidPhoneController(
    context: Context,
) : PhoneController {
    private val appContext = context.applicationContext

    override fun call(number: String): PhoneResult {
        val normalized = normalizePhoneNumber(number)
            ?: return PhoneResult.Failed("That does not look like a phone number.")
        if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.CALL_PHONE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return dial(normalized)
        }
        return start(Intent.ACTION_CALL, normalized, direct = true)
    }

    override fun dial(number: String): PhoneResult {
        val normalized = normalizePhoneNumber(number)
            ?: return PhoneResult.Failed("That does not look like a phone number.")
        return start(Intent.ACTION_DIAL, normalized, direct = false)
    }

    private fun start(action: String, number: String, direct: Boolean): PhoneResult {
        val intent = Intent(action, Uri.parse("tel:$number")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            appContext.startActivity(intent)
            ShivaLog.i(ShivaLog.DEVICE, "Phone intent launched action=$action")
            PhoneResult.Started(number, direct)
        } catch (error: Exception) {
            PhoneResult.Failed("Android could not open the phone app.")
        }
    }
}
