package com.shiva.assistant

import com.shiva.assistant.device.identity.newInstallationId
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceIdentityTest {
    @Test
    fun installationIdIsStableShapeAndNotHardwareDerived() {
        val first = newInstallationId()
        val second = newInstallationId()
        assertTrue(first.startsWith("android_"))
        assertTrue(first.length > 12)
        assertTrue(first != second)
        assertTrue(!first.contains("imei", ignoreCase = true))
    }
}
