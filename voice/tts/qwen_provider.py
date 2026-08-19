import asyncio
from io import BytesIO
from typing import Any

from .provider import SynthesizedSpeech, TTSProviderError


DEFAULT_SPEAKING_INSTRUCTION = (
    "Speak naturally, warmly, and conversationally at a relaxed pace, "
    "with clear phrasing and subtle expressive variation."
)


class QwenTTSProvider:
    """Lazy Qwen3-TTS CustomVoice adapter with no voice-cloning path."""

    def __init__(
        self,
        model_name: str,
        speaker: str = "Aiden",
        language: str = "English",
        device: str = "cuda:0",
        instruction: str = DEFAULT_SPEAKING_INSTRUCTION,
    ) -> None:
        self._model_name = model_name
        self._speaker = speaker
        self._language = language
        self._device = device
        self._instruction = instruction
        self._model: Any | None = None
        self._load_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()

    async def synthesize(self, text: str) -> SynthesizedSpeech:
        model = await self._get_model()
        try:
            async with self._inference_lock:
                wavs, sample_rate = await asyncio.to_thread(
                    model.generate_custom_voice,
                    text=text,
                    language=self._language,
                    speaker=self._speaker,
                    instruct=self._instruction,
                )
            wav = await asyncio.to_thread(
                self._encode_wav,
                wavs[0],
                sample_rate,
            )
        except Exception as error:
            raise TTSProviderError("Qwen TTS inference failed.") from error

        if len(wav) <= 44:
            raise TTSProviderError("Qwen TTS returned empty audio.")
        return SynthesizedSpeech(wav=wav)

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
            from qwen_tts import Qwen3TTSModel

            return Qwen3TTSModel.from_pretrained(
                self._model_name,
                device_map=self._device,
                dtype=torch.bfloat16,
            )
        except Exception as error:
            raise TTSProviderError("Qwen TTS could not be loaded.") from error

    @staticmethod
    def _encode_wav(samples: Any, sample_rate: int) -> bytes:
        import soundfile as sf

        output = BytesIO()
        sf.write(output, samples, sample_rate, format="WAV", subtype="PCM_16")
        return output.getvalue()
