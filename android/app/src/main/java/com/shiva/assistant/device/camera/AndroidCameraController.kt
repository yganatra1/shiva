package com.shiva.assistant.device.camera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.Size
import androidx.core.content.ContextCompat
import com.shiva.assistant.core.logging.ShivaLog
import com.shiva.assistant.device.background.ShivaConnectionService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Captures a still JPEG with Camera2 while the connection foreground service
 * holds FOREGROUND_SERVICE_TYPE_CAMERA. No Activity is launched — background
 * activity starts are blocked on modern Android and were the reason remote
 * capture could not open the camera.
 */
class AndroidCameraController(
    context: Context,
    private val maxBytes: Int = 384 * 1024,
) : CameraController {
    private val appContext = context.applicationContext

    override suspend fun capture(facing: CameraFacing, quality: Int): CameraCaptureResult {
        if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return CameraCaptureResult.PermissionDenied
        }

        return withContext(Dispatchers.IO) {
            val promoted = ShivaConnectionService.promoteForCameraCapture(appContext)
            if (!promoted) {
                return@withContext CameraCaptureResult.Failed(
                    "Could not enable camera capture in the background service.",
                )
            }
            try {
                withTimeout(45_000) {
                    captureWithCamera2(
                        facing = facing,
                        quality = quality.coerceIn(40, 95),
                    )
                }
            } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
                CameraCaptureResult.Failed("Camera capture timed out.")
            } catch (error: Exception) {
                ShivaLog.w(ShivaLog.DEVICE, "Camera capture error: ${error.javaClass.simpleName}")
                CameraCaptureResult.Failed(
                    error.message?.takeIf { it.isNotBlank() } ?: "Camera is unavailable.",
                )
            } finally {
                ShivaConnectionService.demoteCameraCapture()
            }
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun captureWithCamera2(
        facing: CameraFacing,
        quality: Int,
    ): CameraCaptureResult {
        val manager = appContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameraId = pickCameraId(manager, facing)
            ?: return CameraCaptureResult.Failed("No matching camera was found.")

        val thread = HandlerThread("shiva-camera").also { it.start() }
        val handler = Handler(thread.looper)
        val closed = AtomicBoolean(false)

        try {
            val characteristics = manager.getCameraCharacteristics(cameraId)
            val map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?: return CameraCaptureResult.Failed("Camera stream configuration is unavailable.")
            val jpegSizes = map.getOutputSizes(ImageFormat.JPEG) ?: emptyArray()
            val size = chooseJpegSize(jpegSizes)
            val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)

            val device = openCamera(manager, cameraId, handler)
            try {
                val session = createCaptureSession(device, reader, handler)
                try {
                    delay(350)
                    val jpeg = takeStill(device, session, reader, handler, quality)
                    if (jpeg.isEmpty()) {
                        return CameraCaptureResult.Failed("Camera returned an empty image.")
                    }
                    val encoded = compressToLimit(jpeg, quality, maxBytes)
                        ?: return CameraCaptureResult.Failed(
                            "Captured image exceeds the ${maxBytes} byte command limit.",
                        )
                    return CameraCaptureResult.Success(
                        mimeType = "image/jpeg",
                        width = size.width,
                        height = size.height,
                        base64Jpeg = Base64.encodeToString(encoded, Base64.NO_WRAP),
                    )
                } finally {
                    runCatching { session.close() }
                }
            } finally {
                if (closed.compareAndSet(false, true)) {
                    runCatching { device.close() }
                }
                runCatching { reader.close() }
            }
        } finally {
            thread.quitSafely()
        }
    }

    private fun pickCameraId(manager: CameraManager, facing: CameraFacing): String? {
        val wanted = when (facing) {
            CameraFacing.FRONT -> CameraCharacteristics.LENS_FACING_FRONT
            CameraFacing.BACK -> CameraCharacteristics.LENS_FACING_BACK
        }
        for (id in manager.cameraIdList) {
            val facingValue = manager.getCameraCharacteristics(id)
                .get(CameraCharacteristics.LENS_FACING)
            if (facingValue == wanted) return id
        }
        return manager.cameraIdList.firstOrNull()
    }

    private fun chooseJpegSize(sizes: Array<Size>): Size {
        val preferred = sizes
            .filter { it.width * it.height <= 1280 * 720 }
            .maxByOrNull { it.width * it.height }
        return preferred ?: sizes.minByOrNull { it.width * it.height } ?: Size(640, 480)
    }

    @SuppressLint("MissingPermission")
    private suspend fun openCamera(
        manager: CameraManager,
        cameraId: String,
        handler: Handler,
    ): CameraDevice = suspendCancellableCoroutine { continuation ->
        val callback = object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                if (continuation.isActive) continuation.resume(camera)
            }

            override fun onDisconnected(camera: CameraDevice) {
                camera.close()
                if (continuation.isActive) {
                    continuation.resumeWith(
                        Result.failure(IllegalStateException("Camera disconnected.")),
                    )
                }
            }

            override fun onError(camera: CameraDevice, error: Int) {
                camera.close()
                if (continuation.isActive) {
                    continuation.resumeWith(
                        Result.failure(IllegalStateException("Camera open failed ($error).")),
                    )
                }
            }
        }
        manager.openCamera(cameraId, callback, handler)
    }

    private suspend fun createCaptureSession(
        device: CameraDevice,
        reader: ImageReader,
        handler: Handler,
    ): CameraCaptureSession = suspendCancellableCoroutine { continuation ->
        @Suppress("DEPRECATION")
        device.createCaptureSession(
            listOf(reader.surface),
            object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(session: CameraCaptureSession) {
                    if (continuation.isActive) continuation.resume(session)
                }

                override fun onConfigureFailed(session: CameraCaptureSession) {
                    if (continuation.isActive) {
                        continuation.resumeWith(
                            Result.failure(IllegalStateException("Camera session configure failed.")),
                        )
                    }
                }
            },
            handler,
        )
    }

    private suspend fun takeStill(
        device: CameraDevice,
        session: CameraCaptureSession,
        reader: ImageReader,
        handler: Handler,
        quality: Int,
    ): ByteArray = suspendCancellableCoroutine { continuation ->
        reader.setOnImageAvailableListener(
            { imageReader ->
                val image = imageReader.acquireNextImage() ?: return@setOnImageAvailableListener
                try {
                    val buffer = image.planes[0].buffer
                    val bytes = ByteArray(buffer.remaining())
                    buffer.get(bytes)
                    if (continuation.isActive) continuation.resume(bytes)
                } finally {
                    image.close()
                }
            },
            handler,
        )

        val builder = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
            addTarget(reader.surface)
            set(CaptureRequest.JPEG_QUALITY, quality.toByte())
            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
            set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
        }
        session.capture(
            builder.build(),
            object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureFailed(
                    session: CameraCaptureSession,
                    request: CaptureRequest,
                    failure: android.hardware.camera2.CaptureFailure,
                ) {
                    if (continuation.isActive) {
                        continuation.resumeWith(
                            Result.failure(IllegalStateException("Still capture failed.")),
                        )
                    }
                }
            },
            handler,
        )
    }

    private fun compressToLimit(jpeg: ByteArray, startQuality: Int, maxBytes: Int): ByteArray? {
        if (jpeg.size <= maxBytes) return jpeg
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
            ?: return null
        try {
            var q = startQuality
            while (q >= 40) {
                val out = ByteArrayOutputStream()
                bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, q, out)
                val bytes = out.toByteArray()
                if (bytes.size <= maxBytes) return bytes
                q -= 10
            }
            return null
        } finally {
            bitmap.recycle()
        }
    }
}

internal fun parseCameraFacing(raw: String?): CameraFacing {
    return when (raw?.lowercase()) {
        "front", "selfie" -> CameraFacing.FRONT
        else -> CameraFacing.BACK
    }
}

internal fun parseCaptureQuality(raw: String?): Int {
    return (raw?.toIntOrNull() ?: 75).coerceIn(40, 95)
}
