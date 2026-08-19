from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class Transcription:
    text: str
    language: str


class ASRProvider(Protocol):
    async def transcribe(self, wav_path: Path) -> Transcription:
        """Transcribe a normalized mono 16 kHz WAV file."""


class ASRProviderError(RuntimeError):
    """Raised when the configured ASR model cannot complete inference."""
