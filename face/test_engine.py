import asyncio
import math
from pathlib import Path
import unittest

from face.engine import (
    CPU_PROVIDER,
    CUDA_PROVIDER,
    FaceEngineConfig,
    FaceEngineError,
    InsightFaceEngine,
    InvalidImageError,
    QualityConfig,
    QualityMetrics,
    assess_quality,
    normalize_embedding,
    validate_image_dimensions,
)


class FakeSession:
    def __init__(self, provider: str) -> None:
        self._provider = provider

    def get_providers(self) -> list[str]:
        return [self._provider]


class FakeRecognitionModel:
    def __init__(self, provider: str) -> None:
        self.session = FakeSession(provider)


class FakeAnalyzer:
    def __init__(self, provider: str) -> None:
        self.models = {"recognition": FakeRecognitionModel(provider)}
        self.prepare_calls: list[dict[str, object]] = []

    def prepare(self, **arguments: object) -> None:
        self.prepare_calls.append(arguments)


class ProbedEngine(InsightFaceEngine):
    def __init__(
        self,
        available: list[str],
        *,
        execution_provider: str = "cpu",
        require_cuda: bool = False,
        fail_cuda: bool = False,
    ) -> None:
        super().__init__(
            FaceEngineConfig(
                model_root=Path("/unused"),
                execution_provider=execution_provider,
                require_cuda=require_cuda,
            )
        )
        self.available = available
        self.fail_cuda = fail_cuda
        self.create_calls: list[list[object]] = []

    def _available_execution_providers(self) -> list[str]:
        return self.available

    def _create_analyzer(self, providers: list[object]) -> FakeAnalyzer:
        self.create_calls.append(providers)
        first = providers[0]
        provider = first[0] if isinstance(first, tuple) else first
        if provider == CUDA_PROVIDER and self.fail_cuda:
            raise RuntimeError("synthetic CUDA initialization failure")
        return FakeAnalyzer(str(provider))


class FaceEngineTest(unittest.TestCase):
    def test_embedding_is_validated_and_normalized_to_512_dimensions(self) -> None:
        embedding = normalize_embedding([2.0] * 512)

        self.assertEqual(len(embedding), 512)
        self.assertAlmostEqual(
            math.sqrt(sum(value * value for value in embedding)),
            1.0,
        )

        for invalid in ([1.0] * 511, [0.0] * 512, [math.nan] * 512):
            with self.subTest(length=len(invalid)):
                with self.assertRaises(FaceEngineError):
                    normalize_embedding(invalid)

    def test_quality_score_is_bounded_and_reasons_are_machine_stable(self) -> None:
        score, reasons = assess_quality(
            QualityMetrics(
                detection_score=0.55,
                face_width=60,
                face_height=60,
                image_width=1_000,
                image_height=1_000,
                sharpness=10,
                brightness=20,
                touches_frame=True,
            ),
            QualityConfig(),
        )

        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 1.0)
        self.assertEqual(
            reasons,
            (
                "LOW_DETECTION_SCORE",
                "FACE_TOO_SMALL",
                "IMAGE_TOO_BLURRY",
                "IMAGE_TOO_DARK",
                "FACE_PARTIALLY_OUT_OF_FRAME",
            ),
        )

    def test_valid_quality_has_no_rejection_reasons(self) -> None:
        score, reasons = assess_quality(
            QualityMetrics(
                detection_score=0.99,
                face_width=300,
                face_height=300,
                image_width=800,
                image_height=800,
                sharpness=150,
                brightness=128,
                touches_frame=False,
            ),
            QualityConfig(),
        )

        self.assertGreater(score, 0.9)
        self.assertEqual(reasons, ())

    def test_decoded_pixel_limit_is_enforced(self) -> None:
        validate_image_dimensions(4_000, 4_000, 25_000_000)

        with self.assertRaises(InvalidImageError) as caught:
            validate_image_dimensions(10_000, 10_000, 25_000_000)

        self.assertEqual(caught.exception.code, "IMAGE_PIXEL_LIMIT_EXCEEDED")
        self.assertEqual(caught.exception.status_code, 413)

    def test_concurrent_warmup_loads_model_once(self) -> None:
        engine = ProbedEngine([CPU_PROVIDER])

        async def warm_concurrently() -> tuple[str, str, str]:
            first, second = await asyncio.gather(engine.warmup(), engine.warmup())
            third = await engine.warmup()
            return first, second, third

        providers = asyncio.run(warm_concurrently())

        self.assertEqual(providers, (CPU_PROVIDER, CPU_PROVIDER, CPU_PROVIDER))
        self.assertEqual(len(engine.create_calls), 1)
        self.assertTrue(engine.loaded)

    def test_cuda_failure_falls_back_to_cpu(self) -> None:
        engine = ProbedEngine(
            [CUDA_PROVIDER, CPU_PROVIDER],
            execution_provider="auto",
            fail_cuda=True,
        )

        with self.assertLogs("uvicorn.error", level="WARNING"):
            provider = asyncio.run(engine.warmup())

        self.assertEqual(provider, CPU_PROVIDER)
        self.assertEqual(len(engine.create_calls), 2)

    def test_cpu_mode_ignores_available_cuda(self) -> None:
        engine = ProbedEngine([CUDA_PROVIDER, CPU_PROVIDER])

        provider = asyncio.run(engine.warmup())

        self.assertEqual(provider, CPU_PROVIDER)
        self.assertEqual(engine.create_calls, [[CPU_PROVIDER]])

    def test_cuda_mode_rejects_cpu_only_runtime(self) -> None:
        engine = ProbedEngine(
            [CPU_PROVIDER],
            execution_provider="cuda",
        )

        with self.assertRaises(FaceEngineError) as caught:
            asyncio.run(engine.warmup())

        self.assertEqual(caught.exception.phase, "load")
        self.assertEqual(engine.create_calls, [])

    def test_require_cuda_rejects_cpu_only_runtime(self) -> None:
        engine = ProbedEngine([CPU_PROVIDER], require_cuda=True)

        with self.assertRaises(FaceEngineError) as caught:
            asyncio.run(engine.warmup())

        self.assertEqual(caught.exception.phase, "load")
        self.assertEqual(engine.create_calls, [])

    def test_provider_mode_is_normalized_and_validated(self) -> None:
        config = FaceEngineConfig(execution_provider=" CPU ")

        self.assertEqual(config.execution_provider, "cpu")
        with self.assertRaisesRegex(ValueError, "FACE_PROVIDER"):
            FaceEngineConfig(execution_provider="metal")


if __name__ == "__main__":
    unittest.main()
