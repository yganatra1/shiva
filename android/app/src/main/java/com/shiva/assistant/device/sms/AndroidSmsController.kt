package com.shiva.assistant.device.sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.shiva.assistant.core.logging.ShivaLog
import com.shiva.assistant.device.capability.RoleSupport
import com.shiva.assistant.device.phone.normalizePhoneNumber

/**
 * Android restricts sending SMS to the default SMS app role holder for a
 * private/sideloaded build the same way AndroidCapabilityRegistry's SMS
 * capability already models it — this checks the same role rather than
 * relying on the SEND_SMS permission alone.
 */
class AndroidSmsController(
    context: Context,
) : SmsController {
    private val appContext = context.applicationContext
    private val roles = RoleSupport(appContext)

    override fun send(number: String, message: String): SmsResult {
        val normalized = normalizePhoneNumber(number)
            ?: return SmsResult.Failed("That does not look like a phone number.")
        if (message.isBlank()) {
            return SmsResult.Failed("The message body was empty.")
        }
        if (!roles.sms().held) {
            return SmsResult.Failed(
                "Shiva is not the default SMS app. Android requires that role before it will send SMS.",
            )
        }
        if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.SEND_SMS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return SmsResult.Failed("The SMS permission has not been granted.")
        }
        return try {
            @Suppress("DEPRECATION")
            val smsManager = SmsManager.getDefault()
            val parts = smsManager.divideMessage(message)
            if (parts.size > 1) {
                smsManager.sendMultipartTextMessage(normalized, null, parts, null, null)
            } else {
                smsManager.sendTextMessage(normalized, null, message, null, null)
            }
            ShivaLog.i(ShivaLog.DEVICE, "SMS send requested")
            SmsResult.Sent(normalized)
        } catch (error: Exception) {
            SmsResult.Failed("Android could not send the SMS.")
        }
    }
}
