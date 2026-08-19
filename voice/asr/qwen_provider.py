import asyncio
import logging
from pathlib import Path
from time import monotonic
from typing import Any

from .provider import ASRProviderError, NoSpeechError, Transcription


LOGGER = logging.getLogger("uvicorn.error")
SUPPORTED_DTYPES = {"auto", "bfloat16", "float16", "float32"}


class QwenASRProvider:
    """Lazy Qwen3-ASR adapter; model weights load on first transcription only."""

    def __init__(
        self,
        model_name: str,
        device: str = "cuda:0",
        dtype: str = "auto",
    ) -> None:
        if dtype not in SUPPORTED_DTYPES:
            raise ValueError(
                "ASR_DTYPE must be one of auto, bfloat16, float16, or float32."
            )
        self._model_name = model_name
        self._device = device
        self._dtype = dtype
        self._model: Any | None = None
        self._load_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()

    async def transcribe(self, wav_path: Path) -> Transcription:
        model = await self._get_model()
        try:
            async with self._inference_lock:
                results = await asyncio.to_thread(
                    model.transcribe,
                    audio=str(wav_path),
                    language=None,
                )
            result = results[0]
            text = str(result.text).strip()
            language_value = result.language
            language = str(language_value).strip() if language_value else "Unknown"
        except Exception as error:
            raise ASRProviderError(
                "Qwen ASR inference failed.",
                phase="inference",
            ) from error

        if not text:
            raise NoSpeechError("Qwen ASR returned no recognizable speech.")
        return Transcription(text=text, language=language)

    async def _get_model(self) -> Any:
        if self._model is not None:
            return self._model

        async with self._load_lock:
            if self._model is None:
                self._model = await asyncio.to_thread(self._load_model)
        return self._model

    def _load_model(self) -> Any:
        started_at = monotonic()
        try:
            import torch
            from qwen_asr import Qwen3ASRModel

            dtype = resolve_torch_dtype(torch, self._device, self._dtype)
            LOGGER.info(
                "Loading Qwen ASR model model=%s device=%s dtype=%s",
                self._model_name,
                self._device,
                str(dtype),
            )
            model = Qwen3ASRModel.from_pretrained(
                self._model_name,
                dtype=dtype,
                device_map=self._device,
                max_inference_batch_size=1,
                max_new_tokens=256,
            )
            LOGGER.info(
                "Qwen ASR model loaded model=%s duration_ms=%.2f",
                self._model_name,
                (monotonic() - started_at) * 1_000,
            )
            return model
        except Exception as error:
            raise ASRProviderError(
                "Qwen ASR could not be loaded.",
                phase="load",
            ) from error


def resolve_torch_dtype(torch: Any, device: str, requested: str) -> Any:
    """Resolve an explicit or device-safe dtype without importing Torch in tests."""
    if requested != "auto":
        return getattr(torch, requested)

    if device.startswith("cuda"):
        if not torch.cuda.is_available():
            raise RuntimeError(
                f"ASR_DEVICE={device} was requested but CUDA is unavailable."
            )
        capability = torch.cuda.get_device_capability(parse_cuda_index(device))
        return torch.bfloat16 if capability[0] >= 8 else torch.float16

    return torch.float32


def parse_cuda_index(device: str) -> int:
    if ":" not in device:
        return 0
    try:
        return int(device.rsplit(":", 1)[1])
    except ValueError as error:
        raise RuntimeError(f"Invalid ASR CUDA device: {device}.") from error
