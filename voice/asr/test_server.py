from pathlib import Path
import unittest

from fastapi.testclient import TestClient

from voice.asr.provider import ASRProviderError, NoSpeechError, Transcription
from voice.asr.server import InvalidAudioError, create_app


class FakeASRProvider:
    def __init__(self) -> None:
        self.normalized_audio_seen = False
        self.warmup_calls = 0

    async def warmup(self) -> None:
        self.warmup_calls += 1

    async def transcribe(self, wav_path: Path) -> Transcription:
        self.normalized_audio_seen = wav_path.name == "normalized.wav" and wav_path.exists()
        return Transcription(text="Who is my travel partner?", language="English")


class FakeNormalizer:
    def normalize(self, _source: Path, destination: Path) -> None:
        destination.write_bytes(b"RIFF" + (b"\x00" * 40) + b"WAVE")


class RejectingNormalizer:
    def normalize(self, _source: Path, _destination: Path) -> None:
        raise InvalidAudioError("bad audio")


class FailingASRProvider:
    async def warmup(self) -> None:
        try:
            raise RuntimeError("private CUDA failure")
        except RuntimeError as error:
            raise ASRProviderError("safe provider failure", phase="load") from error

    async def transcribe(self, _wav_path: Path) -> Transcription:
        try:
            raise RuntimeError("private CUDA failure")
        except RuntimeError as error:
            raise ASRProviderError("safe provider failure", phase="load") from error


class NoSpeechASRProvider:
    async def warmup(self) -> None:
        return None

    async def transcribe(self, _wav_path: Path) -> Transcription:
        raise NoSpeechError("empty transcription")


class ASRServerTest(unittest.TestCase):
    def test_health_is_liveness_only_and_does_not_warm_provider(self) -> None:
        provider = FakeASRProvider()
        client = TestClient(create_app(provider=provider, normalizer=FakeNormalizer()))

        response = client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(provider.warmup_calls, 0)

    def test_warmup_preloads_provider_and_reports_ready(self) -> None:
        provider = FakeASRProvider()
        client = TestClient(create_app(provider=provider, normalizer=FakeNormalizer()))

        response = client.post("/warmup")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"status": "ready", "service": "asr", "model": "Qwen/Qwen3-ASR-0.6B"},
        )
        self.assertEqual(provider.warmup_calls, 1)

    def test_warmup_failure_is_logged_and_returned_safely(self) -> None:
        client = TestClient(
            create_app(provider=FailingASRProvider(), normalizer=FakeNormalizer())
        )

        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            response = client.post("/warmup")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "The ASR model is unavailable."})
        self.assertIn("ASR warmup failed phase=load", "\n".join(logs.output))
        self.assertIn("private CUDA failure", "\n".join(logs.output))
        self.assertNotIn("private CUDA failure", response.text)

    def test_mock_provider_receives_normalized_audio(self) -> None:
        provider = FakeASRProvider()
        client = TestClient(create_app(provider=provider, normalizer=FakeNormalizer()))

        response = client.post(
            "/transcribe",
            files={"file": ("recording.webm", b"browser-audio", "audio/webm")},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"text": "Who is my travel partner?", "language": "English"},
        )
        self.assertTrue(provider.normalized_audio_seen)
        self.assertEqual(client.get("/health").json()["service"], "asr")

    def test_empty_or_undecodable_audio_is_rejected(self) -> None:
        provider = FakeASRProvider()
        app = create_app(provider=provider, normalizer=RejectingNormalizer())
        client = TestClient(app)

        empty = client.post(
            "/transcribe",
            files={"file": ("empty.webm", b"", "audio/webm")},
        )
        invalid = client.post(
            "/transcribe",
            files={"file": ("bad.webm", b"bad", "audio/webm")},
        )

        self.assertEqual(empty.status_code, 400)
        self.assertEqual(invalid.status_code, 400)

    def test_provider_failure_is_logged_by_phase_and_returned_safely(self) -> None:
        client = TestClient(
            create_app(provider=FailingASRProvider(), normalizer=FakeNormalizer())
        )

        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            response = client.post(
                "/transcribe",
                files={"file": ("recording.webm", b"audio", "audio/webm")},
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "The ASR model is unavailable."})
        self.assertIn("phase=load", "\n".join(logs.output))
        self.assertIn("private CUDA failure", "\n".join(logs.output))
        self.assertNotIn("private CUDA failure", response.text)

    def test_no_speech_is_invalid_audio_not_model_unavailable(self) -> None:
        client = TestClient(
            create_app(provider=NoSpeechASRProvider(), normalizer=FakeNormalizer())
        )

        response = client.post(
            "/transcribe",
            files={"file": ("silence.webm", b"audio", "audio/webm")},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(),
            {"detail": "No speech could be recognized in the uploaded audio."},
        )


if __name__ == "__main__":
    unittest.main()
