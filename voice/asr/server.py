import asyncio
import logging
import os
from pathlib import Path
import subprocess
import tempfile
from time import monotonic
from typing import Annotated

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile

from .provider import ASRProvider, ASRProviderError, NoSpeechError
from .qwen_provider import QwenASRProvider

ROOT_ENVIRONMENT = Path(__file__).resolve().parents[2] / ".env"
MAX_AUDIO_BYTES = 25 * 1024 * 1024
FFMPEG_TIMEOUT_SECONDS = 60
LOGGER = logging.getLogger("uvicorn.error")

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
    device = os.getenv("ASR_DEVICE", "cpu")
    dtype = os.getenv("ASR_DTYPE", "auto")
    selected_provider = provider or QwenASRProvider(
        model_name=model_name,
        device=device,
        dtype=dtype,
    )
    selected_normalizer = normalizer or FfmpegAudioNormalizer()
    application = FastAPI(title="Shiva ASR", version="0.3.0")

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "asr", "model": model_name}

    @application.post("/warmup")
    async def warmup() -> dict[str, str]:
        started_at = monotonic()
        try:
            await selected_provider.warmup()
        except ASRProviderError as error:
            LOGGER.exception(
                "ASR warmup failed phase=%s duration_ms=%.2f "
                "model=%s device=%s dtype=%s",
                error.phase,
                (monotonic() - started_at) * 1_000,
                model_name,
                device,
                dtype,
            )
            raise HTTPException(
                status_code=503,
                detail="The ASR model is unavailable.",
            ) from error

        return {"status": "ready", "service": "asr", "model": model_name}

    @application.post("/transcribe")
    async def transcribe(
        file: Annotated[UploadFile, File(...)],
    ) -> dict[str, str]:
        audio = await file.read(MAX_AUDIO_BYTES + 1)
        if not audio or len(audio) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=400, detail="Invalid audio upload.")

        suffix = safe_audio_suffix(file.filename)
        provider_started_at: float | None = None
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
                provider_started_at = monotonic()
                result = await selected_provider.transcribe(normalized)
        except InvalidAudioError as error:
            # Without this the gateway only sees an opaque 400, which makes a
            # broken capture format indistinguishable from silence.
            LOGGER.warning(
                "ASR rejected an upload filename=%s suffix=%s bytes=%d reason=%s",
                file.filename,
                suffix,
                len(audio),
                error,
                exc_info=True,
            )
            raise HTTPException(
                status_code=400,
                detail="The uploaded audio could not be decoded.",
            ) from error
        except ASRProviderError as error:
            provider_duration_ms = (
                (monotonic() - provider_started_at) * 1_000
                if provider_started_at is not None
                else 0.0
            )
            LOGGER.exception(
                "ASR provider failed phase=%s duration_ms=%.2f "
                "model=%s device=%s dtype=%s",
                error.phase,
                provider_duration_ms,
                model_name,
                device,
                dtype,
            )
            raise HTTPException(
                status_code=503,
                detail="The ASR model is unavailable.",
            ) from error
        except NoSpeechError as error:
            LOGGER.info(
                "ASR found no speech filename=%s bytes=%d",
                file.filename,
                len(audio),
            )
            raise HTTPException(
                status_code=400,
                detail="No speech could be recognized in the uploaded audio.",
            ) from error

        return {"text": result.text, "language": result.language}

    return application


def safe_audio_suffix(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    supported = {".webm", ".ogg", ".mp4", ".m4a", ".mp3", ".wav"}
    return suffix if suffix in supported else ".audio"


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("ASR_HOST", "127.0.0.1"),
        port=int(os.getenv("ASR_PORT", "8101")),
    )
