from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class SynthesizedSpeech:
    wav: bytes


class TTSProvider(Protocol):
    async def synthesize(self, text: str) -> SynthesizedSpeech:
        """Synthesize text as PCM WAV audio."""


class TTSProviderError(RuntimeError):
    """Raised when the configured TTS model cannot complete inference."""

    def __init__(self, message: str, phase: str = "unknown") -> None:
        super().__init__(message)
        self.phase = phase
