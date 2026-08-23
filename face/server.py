from __future__ import annotations

import logging
import os
from pathlib import Path
from time import monotonic
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .engine import (
    AnalysisResult,
    FaceEngine,
    FaceEngineConfig,
    FaceEngineError,
    InsightFaceEngine,
    InvalidImageError,
    QualityConfig,
)


ROOT_ENVIRONMENT = Path(__file__).resolve().parents[1] / ".env"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
ANALYSIS_MODES = {"enroll", "verify", "identify"}
LOGGER = logging.getLogger("uvicorn.error")

load_dotenv(ROOT_ENVIRONMENT)


def create_app(engine: FaceEngine | None = None) -> FastAPI:
    selected_engine = engine or InsightFaceEngine(engine_config_from_environment())
    application = FastAPI(title="Shiva Face", version="0.3.0")

    @application.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "face",
            "model": selected_engine.model_name,
            "loaded": selected_engine.loaded,
            "provider": getattr(selected_engine, "provider", None),
        }

    @application.post("/warmup")
    async def warmup() -> dict[str, Any]:
        started_at = monotonic()
        try:
            provider = await selected_engine.warmup()
        except FaceEngineError as error:
            LOGGER.exception(
                "Face warmup failed phase=%s duration_ms=%.2f model=%s",
                error.phase,
                (monotonic() - started_at) * 1_000,
                selected_engine.model_name,
            )
            raise safe_http_error(
                503,
                "FACE_MODEL_UNAVAILABLE",
                "The face model is unavailable.",
            ) from error
        return {
            "status": "ready",
            "service": "face",
            "model": selected_engine.model_name,
            "provider": provider,
            "dimensions": 512,
        }

    @application.post("/analyze")
    async def analyze(
        request: Request,
        mode: str = Query(default="identify"),
    ) -> JSONResponse:
        if mode not in ANALYSIS_MODES:
            raise safe_http_error(
                400,
                "INVALID_ANALYSIS_MODE",
                "Mode must be enroll, verify, or identify.",
            )
        media_type = (request.headers.get("content-type") or "").split(";", 1)[0]
        media_type = media_type.strip().lower()
        if media_type not in SUPPORTED_IMAGE_TYPES:
            raise safe_http_error(
                415,
                "UNSUPPORTED_IMAGE_TYPE",
                "Upload a JPEG, PNG, or WebP image.",
            )
        image = await read_bounded_body(request, MAX_IMAGE_BYTES)
        max_faces = selected_engine.max_identify_faces if mode == "identify" else 2
        started_at = monotonic()
        try:
            result = await selected_engine.analyze(image, max_faces=max_faces)
        except InvalidImageError as error:
            raise safe_http_error(error.status_code, error.code, str(error)) from error
        except FaceEngineError as error:
            LOGGER.exception(
                "Face analysis failed phase=%s duration_ms=%.2f model=%s mode=%s",
                error.phase,
                (monotonic() - started_at) * 1_000,
                selected_engine.model_name,
                mode,
            )
            raise safe_http_error(
                503,
                "FACE_MODEL_UNAVAILABLE",
                "The face model is unavailable.",
            ) from error

        if mode in {"enroll", "verify"}:
            if len(result.faces) == 0:
                raise safe_http_error(
                    422,
                    "NO_FACE_DETECTED",
                    "The image must contain exactly one visible face.",
                )
            if len(result.faces) > 1:
                raise safe_http_error(
                    422,
                    "MULTIPLE_FACES_DETECTED",
                    "The image must contain exactly one visible face.",
                )

        return JSONResponse(
            content=analysis_payload(result),
            headers={"Cache-Control": "no-store"},
        )

    return application


async def read_bounded_body(request: Request, maximum_bytes: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_bytes = int(declared)
            if declared_bytes < 0:
                raise ValueError("negative content length")
            if declared_bytes > maximum_bytes:
                raise safe_http_error(
                    413,
                    "IMAGE_TOO_LARGE",
                    "The image must not exceed 10 MiB.",
                )
        except ValueError:
            raise safe_http_error(
                400,
                "INVALID_CONTENT_LENGTH",
                "The Content-Length header is invalid.",
            )

    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > maximum_bytes:
            raise safe_http_error(
                413,
                "IMAGE_TOO_LARGE",
                "The image must not exceed 10 MiB.",
            )
        body.extend(chunk)
    if not body:
        raise safe_http_error(400, "EMPTY_IMAGE", "The image is empty.")
    return bytes(body)


def analysis_payload(result: AnalysisResult) -> dict[str, Any]:
    return {
        "model": result.model,
        "dimensions": result.dimensions,
        "provider": result.provider,
        "image": {"width": result.image_width, "height": result.image_height},
        "faces": [
            {
                "embedding": list(face.embedding),
                "boundingBox": {
                    "x1": face.bounding_box.x1,
                    "y1": face.bounding_box.y1,
                    "x2": face.bounding_box.x2,
                    "y2": face.bounding_box.y2,
                },
                "detectionScore": face.detection_score,
                "qualityScore": face.quality_score,
                "enrollmentEligible": face.enrollment_eligible,
                "rejectionReasons": list(face.rejection_reasons),
            }
            for face in result.faces
        ],
    }


def safe_http_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


def engine_config_from_environment() -> FaceEngineConfig:
    return FaceEngineConfig(
        model_name=os.getenv("FACE_MODEL", "buffalo_l"),
        model_root=Path(
            os.getenv("FACE_MODEL_ROOT", str(Path.home() / ".insightface"))
        ),
        detection_size=integer_environment("FACE_DETECTION_SIZE", 640),
        detection_threshold=float_environment("FACE_DETECTION_THRESHOLD", 0.5),
        maximum_image_pixels=integer_environment(
            "FACE_MAX_IMAGE_PIXELS", 25_000_000
        ),
        max_identify_faces=integer_environment("FACE_MAX_IDENTIFY_FACES", 20),
        cuda_device_id=integer_environment("FACE_CUDA_DEVICE_ID", 0),
        execution_provider=os.getenv("FACE_PROVIDER", "cpu"),
        require_cuda=boolean_environment("FACE_REQUIRE_CUDA", False),
        quality=QualityConfig(
            minimum_detection_score=float_environment(
                "FACE_MIN_DETECTION_SCORE", 0.65
            ),
            minimum_face_size=integer_environment("FACE_MIN_FACE_SIZE", 96),
            minimum_sharpness=float_environment("FACE_MIN_SHARPNESS", 40.0),
            minimum_brightness=float_environment("FACE_MIN_BRIGHTNESS", 35.0),
            maximum_brightness=float_environment("FACE_MAX_BRIGHTNESS", 220.0),
        ),
    )


def integer_environment(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError as error:
        raise ValueError(f"{name} must be an integer.") from error


def float_environment(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError as error:
        raise ValueError(f"{name} must be a number.") from error


def boolean_environment(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean.")


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("FACE_HOST", "127.0.0.1"),
        port=int(os.getenv("FACE_PORT", "8103")),
    )
