from pathlib import Path
import unittest

from fastapi.testclient import TestClient

from voice.asr.provider import Transcription
from voice.asr.server import InvalidAudioError, create_app


class FakeASRProvider:
    def __init__(self) -> None:
        self.normalized_audio_seen = False

    async def transcribe(self, wav_path: Path) -> Transcription:
        self.normalized_audio_seen = wav_path.name == "normalized.wav" and wav_path.exists()
        return Transcription(text="Who is my travel partner?", language="English")


class FakeNormalizer:
    def normalize(self, _source: Path, destination: Path) -> None:
        destination.write_bytes(b"RIFF" + (b"\x00" * 40) + b"WAVE")


class RejectingNormalizer:
    def normalize(self, _source: Path, _destination: Path) -> None:
        raise InvalidAudioError("bad audio")


class ASRServerTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
