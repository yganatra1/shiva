import unittest

from fastapi.testclient import TestClient

from face.engine import (
    AnalysisResult,
    BoundingBox,
    FaceEngineError,
    FaceResult,
    InvalidImageError,
)
from face.server import MAX_IMAGE_BYTES, create_app


def result_with_faces(*faces: FaceResult) -> AnalysisResult:
    return AnalysisResult(
        model="buffalo_l",
        dimensions=512,
        provider="CPUExecutionProvider",
        image_width=640,
        image_height=480,
        faces=tuple(faces),
    )


def detected_face(*, eligible: bool = True) -> FaceResult:
    return FaceResult(
        embedding=(1.0,) + (0.0,) * 511,
        bounding_box=BoundingBox(x1=10.5, y1=20.5, x2=210.5, y2=220.5),
        detection_score=0.98,
        quality_score=0.91 if eligible else 0.31,
        enrollment_eligible=eligible,
        rejection_reasons=() if eligible else ("IMAGE_TOO_BLURRY",),
    )


class FakeFaceEngine:
    def __init__(self, result: AnalysisResult | None = None) -> None:
        self.model_name = "buffalo_l"
        self.loaded = False
        self.provider: str | None = None
        self.max_identify_faces = 20
        self.result = result or result_with_faces(detected_face())
        self.warmup_calls = 0
        self.analyze_calls: list[tuple[bytes, int]] = []

    async def warmup(self) -> str:
        self.warmup_calls += 1
        self.loaded = True
        self.provider = "CPUExecutionProvider"
        return "CPUExecutionProvider"

    async def analyze(self, image: bytes, max_faces: int) -> AnalysisResult:
        self.analyze_calls.append((image, max_faces))
        return self.result


class FailingFaceEngine(FakeFaceEngine):
    async def warmup(self) -> str:
        raise FaceEngineError("private model path", phase="load")

    async def analyze(self, image: bytes, max_faces: int) -> AnalysisResult:
        del image, max_faces
        raise FaceEngineError("private CUDA failure", phase="inference")


class InvalidImageEngine(FakeFaceEngine):
    async def analyze(self, image: bytes, max_faces: int) -> AnalysisResult:
        del image, max_faces
        raise InvalidImageError("INVALID_IMAGE", "The image could not be decoded.")


class FaceServerTest(unittest.TestCase):
    def test_health_is_liveness_only_and_does_not_load_model(self) -> None:
        engine = FakeFaceEngine()
        client = TestClient(create_app(engine=engine))

        response = client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "status": "ok",
                "service": "face",
                "model": "buffalo_l",
                "loaded": False,
                "provider": None,
            },
        )
        self.assertEqual(engine.warmup_calls, 0)

    def test_warmup_reports_provider_and_dimensions(self) -> None:
        engine = FakeFaceEngine()
        client = TestClient(create_app(engine=engine))

        response = client.post("/warmup")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "status": "ready",
                "service": "face",
                "model": "buffalo_l",
                "provider": "CPUExecutionProvider",
                "dimensions": 512,
            },
        )
        self.assertEqual(engine.warmup_calls, 1)

    def test_analyze_returns_exact_interoperability_shape(self) -> None:
        engine = FakeFaceEngine()
        client = TestClient(create_app(engine=engine))

        response = client.post(
            "/analyze?mode=enroll",
            content=b"encoded-image",
            headers={"content-type": "image/jpeg"},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(set(payload), {"model", "dimensions", "provider", "image", "faces"})
        self.assertEqual(payload["model"], "buffalo_l")
        self.assertEqual(payload["dimensions"], 512)
        self.assertEqual(payload["image"], {"width": 640, "height": 480})
        self.assertEqual(len(payload["faces"][0]["embedding"]), 512)
        self.assertEqual(
            set(payload["faces"][0]),
            {
                "embedding",
                "boundingBox",
                "detectionScore",
                "qualityScore",
                "enrollmentEligible",
                "rejectionReasons",
            },
        )
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(engine.analyze_calls, [(b"encoded-image", 2)])

    def test_enroll_and_verify_require_exactly_one_face(self) -> None:
        cases = [
            (result_with_faces(), "NO_FACE_DETECTED"),
            (
                result_with_faces(detected_face(), detected_face()),
                "MULTIPLE_FACES_DETECTED",
            ),
        ]
        for result, code in cases:
            for mode in ("enroll", "verify"):
                with self.subTest(mode=mode, code=code):
                    response = TestClient(
                        create_app(engine=FakeFaceEngine(result))
                    ).post(
                        f"/analyze?mode={mode}",
                        content=b"image",
                        headers={"content-type": "image/png"},
                    )
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(response.json()["detail"]["code"], code)

    def test_identify_returns_zero_or_multiple_faces_without_guessing(self) -> None:
        for faces in ((), (detected_face(), detected_face())):
            engine = FakeFaceEngine(result_with_faces(*faces))
            response = TestClient(create_app(engine=engine)).post(
                "/analyze?mode=identify",
                content=b"image",
                headers={"content-type": "image/webp"},
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.json()["faces"]), len(faces))
            self.assertEqual(engine.analyze_calls[0][1], 20)

    def test_low_quality_face_is_explainable_in_success_response(self) -> None:
        engine = FakeFaceEngine(result_with_faces(detected_face(eligible=False)))
        response = TestClient(create_app(engine=engine)).post(
            "/analyze?mode=enroll",
            content=b"image",
            headers={"content-type": "image/jpeg"},
        )

        self.assertEqual(response.status_code, 200)
        face = response.json()["faces"][0]
        self.assertFalse(face["enrollmentEligible"])
        self.assertEqual(face["rejectionReasons"], ["IMAGE_TOO_BLURRY"])
        self.assertGreaterEqual(face["qualityScore"], 0.0)
        self.assertLessEqual(face["qualityScore"], 1.0)

    def test_body_type_size_and_mode_are_bounded(self) -> None:
        client = TestClient(create_app(engine=FakeFaceEngine()))
        cases = [
            (
                client.post(
                    "/analyze",
                    content=b"image",
                    headers={"content-type": "application/octet-stream"},
                ),
                415,
                "UNSUPPORTED_IMAGE_TYPE",
            ),
            (
                client.post(
                    "/analyze?mode=unknown",
                    content=b"image",
                    headers={"content-type": "image/jpeg"},
                ),
                400,
                "INVALID_ANALYSIS_MODE",
            ),
            (
                client.post(
                    "/analyze",
                    content=b"",
                    headers={"content-type": "image/jpeg"},
                ),
                400,
                "EMPTY_IMAGE",
            ),
            (
                client.post(
                    "/analyze",
                    content=b"x",
                    headers={
                        "content-type": "image/jpeg",
                        "content-length": str(MAX_IMAGE_BYTES + 1),
                    },
                ),
                413,
                "IMAGE_TOO_LARGE",
            ),
        ]
        for response, status, code in cases:
            with self.subTest(code=code):
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["detail"]["code"], code)

    def test_decode_and_model_failures_are_sanitized(self) -> None:
        invalid = TestClient(create_app(engine=InvalidImageEngine())).post(
            "/analyze",
            content=b"invalid",
            headers={"content-type": "image/jpeg"},
        )
        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            unavailable = TestClient(create_app(engine=FailingFaceEngine())).post(
                "/analyze",
                content=b"image",
                headers={"content-type": "image/jpeg"},
            )

        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["detail"]["code"], "INVALID_IMAGE")
        self.assertEqual(unavailable.status_code, 503)
        self.assertEqual(
            unavailable.json()["detail"]["code"],
            "FACE_MODEL_UNAVAILABLE",
        )
        self.assertIn("private CUDA failure", "\n".join(logs.output))
        self.assertNotIn("private CUDA failure", unavailable.text)


if __name__ == "__main__":
    unittest.main()
