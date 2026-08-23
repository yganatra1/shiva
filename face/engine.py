from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from io import BytesIO
import logging
import math
from pathlib import Path
from typing import Any, Protocol, Sequence
import warnings


LOGGER = logging.getLogger("uvicorn.error")
EMBEDDING_DIMENSIONS = 512
CUDA_PROVIDER = "CUDAExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"
PROVIDER_MODES = frozenset({"auto", "cpu", "cuda"})

# A cancelled coroutine cannot stop native ONNX work already in progress. A
# process-wide single worker keeps the next request from overlapping that work.
_INFERENCE_EXECUTOR = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="shiva-face-inference",
)


class InvalidImageError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class FaceEngineError(RuntimeError):
    def __init__(self, message: str, phase: str = "unknown") -> None:
        super().__init__(message)
        self.phase = phase


@dataclass(frozen=True)
class BoundingBox:
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass(frozen=True)
class FaceResult:
    embedding: tuple[float, ...]
    bounding_box: BoundingBox
    detection_score: float
    quality_score: float
    enrollment_eligible: bool
    rejection_reasons: tuple[str, ...]


@dataclass(frozen=True)
class AnalysisResult:
    model: str
    dimensions: int
    provider: str
    image_width: int
    image_height: int
    faces: tuple[FaceResult, ...]


class FaceEngine(Protocol):
    @property
    def model_name(self) -> str: ...

    @property
    def loaded(self) -> bool: ...

    @property
    def provider(self) -> str | None: ...

    @property
    def max_identify_faces(self) -> int: ...

    async def warmup(self) -> str: ...

    async def analyze(self, image: bytes, max_faces: int) -> AnalysisResult: ...


@dataclass(frozen=True)
class QualityConfig:
    minimum_detection_score: float = 0.65
    minimum_face_size: int = 96
    minimum_sharpness: float = 40.0
    minimum_brightness: float = 35.0
    maximum_brightness: float = 220.0
    frame_margin_ratio: float = 0.01

    def __post_init__(self) -> None:
        numeric_values = (
            self.minimum_detection_score,
            self.minimum_sharpness,
            self.minimum_brightness,
            self.maximum_brightness,
            self.frame_margin_ratio,
        )
        if not all(math.isfinite(value) for value in numeric_values):
            raise ValueError("Face quality thresholds must be finite.")
        if not 0.0 <= self.minimum_detection_score <= 1.0:
            raise ValueError("FACE_MIN_DETECTION_SCORE must be between 0 and 1.")
        if self.minimum_face_size < 1:
            raise ValueError("FACE_MIN_FACE_SIZE must be positive.")
        if self.minimum_sharpness < 0.0:
            raise ValueError("FACE_MIN_SHARPNESS must be non-negative.")
        if not (
            0.0
            <= self.minimum_brightness
            < self.maximum_brightness
            <= 255.0
        ):
            raise ValueError("Face brightness thresholds must be ordered in 0..255.")
        if not 0.0 <= self.frame_margin_ratio <= 0.25:
            raise ValueError("Face frame margin ratio must be between 0 and 0.25.")


@dataclass(frozen=True)
class FaceEngineConfig:
    model_name: str = "buffalo_l"
    model_root: Path = Path.home() / ".insightface"
    detection_size: int = 640
    detection_threshold: float = 0.5
    maximum_image_pixels: int = 25_000_000
    max_identify_faces: int = 20
    cuda_device_id: int = 0
    execution_provider: str = "cpu"
    require_cuda: bool = False
    quality: QualityConfig = QualityConfig()

    def __post_init__(self) -> None:
        if not self.model_name.strip():
            raise ValueError("FACE_MODEL must not be empty.")
        if self.detection_size < 128 or self.detection_size > 2_048:
            raise ValueError("FACE_DETECTION_SIZE must be between 128 and 2048.")
        if not 0.0 <= self.detection_threshold <= 1.0:
            raise ValueError("FACE_DETECTION_THRESHOLD must be between 0 and 1.")
        if self.maximum_image_pixels < 1:
            raise ValueError("FACE_MAX_IMAGE_PIXELS must be positive.")
        if not 1 <= self.max_identify_faces <= 100:
            raise ValueError("FACE_MAX_IDENTIFY_FACES must be between 1 and 100.")
        if self.cuda_device_id < 0:
            raise ValueError("FACE_CUDA_DEVICE_ID must be non-negative.")
        normalized_provider = self.execution_provider.strip().lower()
        if normalized_provider not in PROVIDER_MODES:
            raise ValueError("FACE_PROVIDER must be one of: cpu, auto, cuda.")
        object.__setattr__(self, "execution_provider", normalized_provider)


@dataclass(frozen=True)
class _LoadedModel:
    analyzer: Any
    provider: str


@dataclass(frozen=True)
class QualityMetrics:
    detection_score: float
    face_width: float
    face_height: float
    image_width: int
    image_height: int
    sharpness: float
    brightness: float
    touches_frame: bool


class InsightFaceEngine:
    """Lazy buffalo_l adapter that never retains source images."""

    def __init__(self, config: FaceEngineConfig) -> None:
        self._config = config
        self._model: _LoadedModel | None = None
        self._load_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()

    @property
    def model_name(self) -> str:
        return self._config.model_name

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def provider(self) -> str | None:
        return self._model.provider if self._model is not None else None

    @property
    def max_identify_faces(self) -> int:
        return self._config.max_identify_faces

    async def warmup(self) -> str:
        return (await self._get_model()).provider

    async def analyze(self, image: bytes, max_faces: int) -> AnalysisResult:
        if not 1 <= max_faces <= 100:
            raise ValueError("max_faces must be between 1 and 100.")
        model = await self._get_model()
        try:
            async with self._inference_lock:
                return await asyncio.get_running_loop().run_in_executor(
                    _INFERENCE_EXECUTOR,
                    self._analyze_sync,
                    model,
                    image,
                    max_faces,
                )
        except (InvalidImageError, FaceEngineError):
            raise
        except Exception as error:
            raise FaceEngineError(
                "InsightFace inference failed.",
                phase="inference",
            ) from error

    async def _get_model(self) -> _LoadedModel:
        if self._model is not None:
            return self._model
        async with self._load_lock:
            if self._model is None:
                self._model = await asyncio.to_thread(self._load_model)
        return self._model

    def _load_model(self) -> _LoadedModel:
        available = set(self._available_execution_providers())
        provider_mode = (
            "cuda"
            if self._config.require_cuda
            else self._config.execution_provider
        )
        if provider_mode == "cuda" and CUDA_PROVIDER not in available:
            raise FaceEngineError(
                "CUDA was required but is unavailable.",
                phase="load",
            )
        if provider_mode in {"cpu", "auto"} and CPU_PROVIDER not in available:
            if provider_mode == "cpu" or CUDA_PROVIDER not in available:
                raise FaceEngineError(
                    "The selected ONNX execution provider is unavailable.",
                    phase="load",
                )

        attempts: list[tuple[list[Any], int]] = []
        if provider_mode in {"auto", "cuda"} and CUDA_PROVIDER in available:
            cuda_providers: list[Any] = [
                (
                    CUDA_PROVIDER,
                    {"device_id": self._config.cuda_device_id},
                )
            ]
            if CPU_PROVIDER in available:
                cuda_providers.append(CPU_PROVIDER)
            attempts.append(
                (
                    cuda_providers,
                    self._config.cuda_device_id,
                )
            )
        if provider_mode in {"cpu", "auto"} and CPU_PROVIDER in available:
            attempts.append(([CPU_PROVIDER], -1))

        last_error: Exception | None = None
        for index, (providers, context_id) in enumerate(attempts):
            try:
                analyzer = self._create_analyzer(providers)
                analyzer.prepare(
                    ctx_id=context_id,
                    det_thresh=self._config.detection_threshold,
                    det_size=(
                        self._config.detection_size,
                        self._config.detection_size,
                    ),
                )
                provider = self._recognition_provider(analyzer, providers)
                if provider_mode == "cuda" and provider != CUDA_PROVIDER:
                    raise RuntimeError(
                        "Recognition model did not initialize with CUDA."
                    )
                if provider_mode == "auto" and index > 0:
                    LOGGER.warning(
                        "InsightFace CUDA initialization failed; using CPU fallback."
                    )
                return _LoadedModel(analyzer=analyzer, provider=provider)
            except Exception as error:
                last_error = error
                if provider_mode != "auto" or index == len(attempts) - 1:
                    break
                LOGGER.warning(
                    "InsightFace CUDA initialization failed; retrying on CPU.",
                    exc_info=True,
                )

        raise FaceEngineError(
            "InsightFace could not be loaded.",
            phase="load",
        ) from last_error

    def _available_execution_providers(self) -> Sequence[str]:
        try:
            import onnxruntime as ort

            return ort.get_available_providers()
        except Exception as error:
            raise FaceEngineError(
                "ONNX Runtime could not be inspected.",
                phase="load",
            ) from error

    def _create_analyzer(self, providers: list[Any]) -> Any:
        try:
            from insightface.app import FaceAnalysis

            return FaceAnalysis(
                name=self._config.model_name,
                root=str(self._config.model_root.expanduser()),
                allowed_modules=["detection", "recognition"],
                providers=providers,
            )
        except Exception as error:
            raise FaceEngineError(
                "InsightFace model initialization failed.",
                phase="load",
            ) from error

    @staticmethod
    def _recognition_provider(analyzer: Any, requested: list[Any]) -> str:
        recognition = getattr(analyzer, "models", {}).get("recognition")
        if recognition is None:
            raise RuntimeError("buffalo_l recognition model is missing.")
        session = getattr(recognition, "session", None)
        if session is not None and hasattr(session, "get_providers"):
            actual = session.get_providers()
            if actual:
                return str(actual[0])
        first = requested[0]
        return str(first[0] if isinstance(first, tuple) else first)

    def _analyze_sync(
        self,
        model: _LoadedModel,
        encoded_image: bytes,
        max_faces: int,
    ) -> AnalysisResult:
        image, width, height = self._decode_image(encoded_image)
        try:
            raw_faces = model.analyzer.get(image, max_num=max_faces)
        except Exception as error:
            raise FaceEngineError(
                "InsightFace detection or recognition failed.",
                phase="inference",
            ) from error

        faces = [self._map_face(image, width, height, face) for face in raw_faces]
        faces.sort(
            key=lambda face: (
                face.bounding_box.y1,
                face.bounding_box.x1,
                face.bounding_box.y2,
                face.bounding_box.x2,
            )
        )
        return AnalysisResult(
            model=self._config.model_name,
            dimensions=EMBEDDING_DIMENSIONS,
            provider=model.provider,
            image_width=width,
            image_height=height,
            faces=tuple(faces),
        )

    def _decode_image(self, encoded_image: bytes) -> tuple[Any, int, int]:
        try:
            import numpy as np
            from PIL import Image, ImageOps

            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(encoded_image)) as source:
                    if source.format not in {"JPEG", "PNG", "WEBP"}:
                        raise InvalidImageError(
                            "UNSUPPORTED_IMAGE_FORMAT",
                            "The image is not JPEG, PNG, or WebP.",
                            415,
                        )
                    if getattr(source, "is_animated", False):
                        raise InvalidImageError(
                            "ANIMATED_IMAGE_UNSUPPORTED",
                            "Animated images are not supported.",
                            415,
                        )
                    validate_image_dimensions(
                        source.width,
                        source.height,
                        self._config.maximum_image_pixels,
                    )
                    source.load()
                    oriented = ImageOps.exif_transpose(source).convert("RGB")
                    validate_image_dimensions(
                        oriented.width,
                        oriented.height,
                        self._config.maximum_image_pixels,
                    )
                    rgb = np.asarray(oriented, dtype=np.uint8)
                    image = np.ascontiguousarray(rgb[:, :, ::-1])
                    return image, int(oriented.width), int(oriented.height)
        except InvalidImageError:
            raise
        except (OSError, SyntaxError, ValueError) as error:
            raise InvalidImageError(
                "INVALID_IMAGE",
                "The image could not be decoded.",
            ) from error
        except Exception as error:
            # Pillow's decompression-bomb warning is promoted to an exception.
            if type(error).__name__ in {
                "DecompressionBombError",
                "DecompressionBombWarning",
            }:
                raise InvalidImageError(
                    "IMAGE_PIXEL_LIMIT_EXCEEDED",
                    "The decoded image is too large.",
                    413,
                ) from error
            raise FaceEngineError(
                "Image decoding failed.",
                phase="decode",
            ) from error

    def _map_face(
        self,
        image: Any,
        image_width: int,
        image_height: int,
        face: Any,
    ) -> FaceResult:
        bbox_values = sequence_values(face_value(face, "bbox"))
        if len(bbox_values) < 4:
            raise FaceEngineError("Invalid face bounding box.", phase="response")
        coordinates = tuple(float(value) for value in bbox_values[:4])
        if not all(math.isfinite(value) for value in coordinates):
            raise FaceEngineError("Non-finite face bounding box.", phase="response")
        x1, y1, x2, y2 = coordinates
        x1 = clamp(x1, 0.0, float(image_width))
        y1 = clamp(y1, 0.0, float(image_height))
        x2 = clamp(x2, 0.0, float(image_width))
        y2 = clamp(y2, 0.0, float(image_height))
        if x2 <= x1 or y2 <= y1:
            raise FaceEngineError("Empty face bounding box.", phase="response")
        bounding_box = BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2)

        detection_score = float(face_value(face, "det_score"))
        if not math.isfinite(detection_score) or not 0.0 <= detection_score <= 1.0:
            raise FaceEngineError("Invalid detection score.", phase="response")

        embedding = normalize_embedding(
            sequence_values(face_value(face, "embedding"))
        )
        metrics = self._quality_metrics(
            image,
            image_width,
            image_height,
            bounding_box,
            detection_score,
        )
        quality_score, reasons = assess_quality(metrics, self._config.quality)
        return FaceResult(
            embedding=embedding,
            bounding_box=bounding_box,
            detection_score=detection_score,
            quality_score=quality_score,
            enrollment_eligible=not reasons,
            rejection_reasons=reasons,
        )

    def _quality_metrics(
        self,
        image: Any,
        image_width: int,
        image_height: int,
        box: BoundingBox,
        detection_score: float,
    ) -> QualityMetrics:
        try:
            import cv2

            left = max(0, int(math.floor(box.x1)))
            top = max(0, int(math.floor(box.y1)))
            right = min(image_width, int(math.ceil(box.x2)))
            bottom = min(image_height, int(math.ceil(box.y2)))
            crop = image[top:bottom, left:right]
            if getattr(crop, "size", 0) == 0:
                raise ValueError("empty face crop")
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            brightness = float(gray.mean())
            if not math.isfinite(sharpness) or not math.isfinite(brightness):
                raise ValueError("non-finite face quality metric")
        except Exception as error:
            raise FaceEngineError(
                "Face quality analysis failed.",
                phase="quality",
            ) from error

        margin_x = image_width * self._config.quality.frame_margin_ratio
        margin_y = image_height * self._config.quality.frame_margin_ratio
        return QualityMetrics(
            detection_score=detection_score,
            face_width=box.x2 - box.x1,
            face_height=box.y2 - box.y1,
            image_width=image_width,
            image_height=image_height,
            sharpness=sharpness,
            brightness=brightness,
            touches_frame=(
                box.x1 <= margin_x
                or box.y1 <= margin_y
                or box.x2 >= image_width - margin_x
                or box.y2 >= image_height - margin_y
            ),
        )


def validate_image_dimensions(width: Any, height: Any, maximum_pixels: int) -> None:
    if isinstance(width, bool) or isinstance(height, bool):
        raise InvalidImageError("INVALID_IMAGE_DIMENSIONS", "Invalid image dimensions.")
    try:
        parsed_width = int(width)
        parsed_height = int(height)
    except (TypeError, ValueError) as error:
        raise InvalidImageError(
            "INVALID_IMAGE_DIMENSIONS",
            "Invalid image dimensions.",
        ) from error
    if parsed_width < 1 or parsed_height < 1:
        raise InvalidImageError("INVALID_IMAGE_DIMENSIONS", "Invalid image dimensions.")
    if parsed_width * parsed_height > maximum_pixels:
        raise InvalidImageError(
            "IMAGE_PIXEL_LIMIT_EXCEEDED",
            "The decoded image is too large.",
            413,
        )


def normalize_embedding(values: Sequence[Any]) -> tuple[float, ...]:
    if len(values) != EMBEDDING_DIMENSIONS:
        raise FaceEngineError("Invalid face embedding dimensions.", phase="response")
    embedding = tuple(float(value) for value in values)
    if not all(math.isfinite(value) for value in embedding):
        raise FaceEngineError("Non-finite face embedding.", phase="response")
    norm = math.sqrt(math.fsum(value * value for value in embedding))
    if not math.isfinite(norm) or norm <= 1e-12:
        raise FaceEngineError("Empty face embedding.", phase="response")
    return tuple(value / norm for value in embedding)


def assess_quality(
    metrics: QualityMetrics,
    config: QualityConfig,
) -> tuple[float, tuple[str, ...]]:
    minimum_side = min(metrics.face_width, metrics.face_height)
    relative_size = minimum_side / max(1.0, min(metrics.image_width, metrics.image_height))
    detection_component = clamp((metrics.detection_score - 0.5) / 0.5)
    size_component = min(
        clamp(minimum_side / 160.0),
        clamp(relative_size / 0.20),
    )
    sharpness_component = clamp(metrics.sharpness / 100.0)
    exposure_component = clamp(1.0 - abs(metrics.brightness - 127.5) / 127.5)
    framing_component = 0.0 if metrics.touches_frame else 1.0
    score = clamp(
        0.30 * detection_component
        + 0.25 * size_component
        + 0.20 * sharpness_component
        + 0.15 * exposure_component
        + 0.10 * framing_component
    )

    reasons: list[str] = []
    if metrics.detection_score < config.minimum_detection_score:
        reasons.append("LOW_DETECTION_SCORE")
    if minimum_side < config.minimum_face_size:
        reasons.append("FACE_TOO_SMALL")
    if metrics.sharpness < config.minimum_sharpness:
        reasons.append("IMAGE_TOO_BLURRY")
    if metrics.brightness < config.minimum_brightness:
        reasons.append("IMAGE_TOO_DARK")
    elif metrics.brightness > config.maximum_brightness:
        reasons.append("IMAGE_TOO_BRIGHT")
    if metrics.touches_frame:
        reasons.append("FACE_PARTIALLY_OUT_OF_FRAME")
    return round(score, 6), tuple(reasons)


def face_value(face: Any, key: str) -> Any:
    value = getattr(face, key, None)
    if value is None and isinstance(face, dict):
        value = face.get(key)
    if value is None:
        raise FaceEngineError(f"Face result is missing {key}.", phase="response")
    return value


def sequence_values(value: Any) -> list[Any]:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple)):
        raise FaceEngineError("Face result contains an invalid array.", phase="response")
    return list(value)


def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return min(upper, max(lower, value))
