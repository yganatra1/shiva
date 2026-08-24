package com.shiva.assistant.device.camera

sealed interface CameraCaptureResult {
    data class Success(
        val mimeType: String,
        val width: Int,
        val height: Int,
        val base64Jpeg: String,
    ) : CameraCaptureResult

    data class Failed(val reason: String) : CameraCaptureResult
    data object PermissionDenied : CameraCaptureResult
}

interface CameraController {
    suspend fun capture(facing: CameraFacing = CameraFacing.BACK, quality: Int = 85): CameraCaptureResult
}

enum class CameraFacing {
    BACK,
    FRONT,
}
