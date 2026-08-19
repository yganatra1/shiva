import asyncio
import os
from pathlib import Path
import subprocess
import tempfile
from typing import Annotated

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile

from .provider import ASRProvider, ASRProviderError
from .qwen_provider import QwenASRProvider

ROOT_ENVIRONMENT = Path(__file__).resolve().parents[2] / ".env"
MAX_AUDIO_BYTES = 25 * 1024 * 1024
FFMPEG_TIMEOUT_SECONDS = 60

load_dotenv(ROOT_ENVIRONMENT)


class InvalidAudioError(ValueError):
    """Raised when ffmpeg cannot decode or normalize an upload."""


class FfmpegAudioNormalizer:
    def normalize(self, source: Path, destination: Path) -> None:
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(source),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(destination),
                ],
                check=True,
                capture_output=True,
                timeout=FFMPEG_TIMEOUT_SECONDS,
            )
        except (FileNotFoundError, subprocess.SubprocessError) as error:
            raise InvalidAudioError("Audio normalization failed.") from error

        if not destination.is_file() or destination.stat().st_size <= 44:
            raise InvalidAudioError("Audio normalization produced no audio.")


def create_app(
    provider: ASRProvider | None = None,
    normalizer: FfmpegAudioNormalizer | None = None,
) -> FastAPI:
    model_name = os.getenv("ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
    selected_provider = provider or QwenASRProvider(
        model_name=model_name,
        device=os.getenv("ASR_DEVICE", "cuda:0"),
    )
    selected_normalizer = normalizer or FfmpegAudioNormalizer()
    application = FastAPI(title="Shiva ASR", version="0.3.0")

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "asr", "model": model_name}

    @application.post("/transcribe")
    async def transcribe(
        file: Annotated[UploadFile, File(...)],
    ) -> dict[str, str]:
        audio = await file.read(MAX_AUDIO_BYTES + 1)
        if not audio or len(audio) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=400, detail="Invalid audio upload.")

        suffix = safe_audio_suffix(file.filename)
        try:
            with tempfile.TemporaryDirectory(prefix="shiva-asr-") as directory:
                source = Path(directory) / f"upload{suffix}"
                normalized = Path(directory) / "normalized.wav"
                await asyncio.to_thread(source.write_bytes, audio)
                await asyncio.to_thread(
                    selected_normalizer.normalize,
                    source,
                    normalized,
                )
                result = await selected_provider.transcribe(normalized)
        except InvalidAudioError as error:
            raise HTTPException(
                status_code=400,
                detail="The uploaded audio could not be decoded.",
            ) from error
        except ASRProviderError as error:
            raise HTTPException(
                status_code=503,
                detail="The ASR model is unavailable.",
            ) from error

        return {"text": result.text, "language": result.language}

    return application


def safe_audio_suffix(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    return suffix if suffix in {".webm", ".ogg", ".mp4", ".m4a", ".mp3", ".wav"} else ".audio"


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("ASR_HOST", "127.0.0.1"),
        port=int(os.getenv("ASR_PORT", "8101")),
    )
