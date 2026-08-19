import unittest

from fastapi.testclient import TestClient

from voice.tts.provider import SynthesizedSpeech, TTSProviderError
from voice.tts.server import create_app


def test_wav() -> bytes:
    return b"RIFF" + (b"\x00" * 4) + b"WAVE" + (b"\x00" * 36)


class FakeTTSProvider:
    def __init__(self) -> None:
        self.texts: list[str] = []

    async def synthesize(self, text: str) -> SynthesizedSpeech:
        self.texts.append(text)
        return SynthesizedSpeech(wav=test_wav())


class FailingTTSProvider:
    async def synthesize(self, _text: str) -> SynthesizedSpeech:
        raise TTSProviderError("unavailable")


class TTSServerTest(unittest.TestCase):
    def test_mock_provider_returns_wav(self) -> None:
        provider = FakeTTSProvider()
        client = TestClient(create_app(provider=provider))

        response = client.post("/synthesize", json={"text": "Hello, Yash."})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertEqual(response.content, test_wav())
        self.assertEqual(provider.texts, ["Hello, Yash."])
        self.assertEqual(client.get("/health").json()["speaker"], "Aiden")

    def test_invalid_text_and_provider_failure_are_safe(self) -> None:
        invalid = TestClient(create_app(provider=FakeTTSProvider())).post(
            "/synthesize",
            json={"text": "   "},
        )
        unavailable = TestClient(create_app(provider=FailingTTSProvider())).post(
            "/synthesize",
            json={"text": "Hello"},
        )

        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(unavailable.status_code, 503)


if __name__ == "__main__":
    unittest.main()
