package com.shiva.assistant

import com.shiva.assistant.device.capability.CapabilityStatus
import com.shiva.assistant.device.capability.mapRuntimePermission
import org.junit.Assert.assertEquals
import org.junit.Test

class CapabilityStatusTest {
    @Test
    fun grantedPermissionIsAvailable() {
        assertEquals(CapabilityStatus.AVAILABLE, mapRuntimePermission(granted = true))
    }

    @Test
    fun missingPermissionIsRequired() {
        assertEquals(CapabilityStatus.PERMISSION_REQUIRED, mapRuntimePermission(granted = false))
    }

    @Test
    fun unsupportedHardwareWins() {
        assertEquals(
            CapabilityStatus.NOT_SUPPORTED,
            mapRuntimePermission(granted = true, supported = false),
        )
    }
}
