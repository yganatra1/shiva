import asyncio
from pathlib import Path
from typing import Any

from .provider import ASRProviderError, Transcription


class QwenASRProvider:
    """Lazy Qwen3-ASR adapter; model weights load on first transcription only."""

    def __init__(self, model_name: str, device: str = "cuda:0") -> None:
        self._model_name = model_name
        self._device = device
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
            raise ASRProviderError("Qwen ASR inference failed.") from error

        if not text:
            raise ASRProviderError("Qwen ASR returned an empty transcription.")
        return Transcription(text=text, language=language)

    async def _get_model(self) -> Any:
        if self._model is not None:
            return self._model

        async with self._load_lock:
            if self._model is None:
                self._model = await asyncio.to_thread(self._load_model)
        return self._model

    def _load_model(self) -> Any:
        try:
            import torch
            from qwen_asr import Qwen3ASRModel

            return Qwen3ASRModel.from_pretrained(
                self._model_name,
                dtype=torch.bfloat16,
                device_map=self._device,
                max_inference_batch_size=1,
                max_new_tokens=256,
            )
        except Exception as error:
            raise ASRProviderError("Qwen ASR could not be loaded.") from error
