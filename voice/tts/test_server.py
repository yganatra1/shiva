import unittest

from fastapi.testclient import TestClient

from voice.tts.provider import SynthesizedSpeech, TTSProviderError
from voice.tts.server import create_app


def test_wav() -> bytes:
    return b"RIFF" + (b"\x00" * 4) + b"WAVE" + (b"\x00" * 36)


class FakeTTSProvider:
    def __init__(self) -> None:
        self.texts: list[str] = []
        self.warmup_calls = 0

    async def warmup(self) -> None:
        self.warmup_calls += 1

    async def synthesize(self, text: str) -> SynthesizedSpeech:
        self.texts.append(text)
        return SynthesizedSpeech(wav=test_wav())


class FailingTTSProvider:
    async def warmup(self) -> None:
        self._raise_unavailable()

    async def synthesize(self, _text: str) -> SynthesizedSpeech:
        self._raise_unavailable()
        raise AssertionError("unreachable")

    @staticmethod
    def _raise_unavailable() -> None:
        try:
            raise RuntimeError("private TTS load failure")
        except RuntimeError as error:
            raise TTSProviderError("unavailable", phase="load") from error


class TTSServerTest(unittest.TestCase):
    def test_health_is_liveness_only_and_does_not_warm_provider(self) -> None:
        provider = FakeTTSProvider()
        client = TestClient(create_app(provider=provider))

        response = client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(provider.warmup_calls, 0)

    def test_mock_provider_returns_wav(self) -> None:
        provider = FakeTTSProvider()
        client = TestClient(create_app(provider=provider))

        response = client.post("/synthesize", json={"text": "Hello, Yash."})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertEqual(response.content, test_wav())
        self.assertEqual(provider.texts, ["Hello, Yash."])
        self.assertEqual(client.get("/health").json()["speaker"], "Aiden")

    def test_warmup_uses_provider_and_is_safe_to_repeat(self) -> None:
        provider = FakeTTSProvider()
        client = TestClient(create_app(provider=provider))

        first = client.post("/warmup")
        second = client.post("/warmup")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(
            first.json(),
            {
                "status": "ready",
                "service": "tts",
                "model": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
            },
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(provider.warmup_calls, 2)
        self.assertEqual(provider.texts, [])

    def test_invalid_text_and_provider_failure_are_safe(self) -> None:
        invalid = TestClient(create_app(provider=FakeTTSProvider())).post(
            "/synthesize",
            json={"text": "   "},
        )
        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            unavailable = TestClient(create_app(provider=FailingTTSProvider())).post(
                "/synthesize",
                json={"text": "Hello"},
            )

        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(unavailable.status_code, 503)
        self.assertIn("phase=load", "\n".join(logs.output))
        self.assertIn("private TTS load failure", "\n".join(logs.output))
        self.assertNotIn("private TTS load failure", unavailable.text)

    def test_warmup_provider_failure_is_safe(self) -> None:
        client = TestClient(create_app(provider=FailingTTSProvider()))

        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            unavailable = client.post("/warmup")

        self.assertEqual(unavailable.status_code, 503)
        self.assertEqual(
            unavailable.json(),
            {"detail": "The TTS model is unavailable."},
        )
        self.assertIn("TTS warmup failed phase=load", "\n".join(logs.output))
        self.assertIn("private TTS load failure", "\n".join(logs.output))
        self.assertNotIn("private TTS load failure", unavailable.text)


if __name__ == "__main__":
    unittest.main()
