import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from importlib.metadata import PackageNotFoundError, version
from io import BytesIO
import logging
from time import monotonic
from typing import Any

from ..huggingface_runtime import prepare_huggingface_environment

from .provider import SynthesizedSpeech, TTSProviderError


LOGGER = logging.getLogger("uvicorn.error")
SUPPORTED_DTYPES = {"auto", "bfloat16", "float16", "float32"}

# asyncio cancellation cannot stop a function that is already running through
# to_thread/run_in_executor. A process-wide, single-worker executor therefore
# remains the final serialization boundary even if the request coroutine is
# cancelled and releases its asyncio lock while Qwen is still generating.
_TTS_INFERENCE_EXECUTOR = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="shiva-tts-inference",
)


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
        dtype: str = "auto",
        instruction: str = DEFAULT_SPEAKING_INSTRUCTION,
    ) -> None:
        if dtype not in SUPPORTED_DTYPES:
            raise ValueError(
                "TTS_DTYPE must be one of auto, bfloat16, float16, or float32."
            )
        self._model_name = model_name
        self._speaker = speaker
        self._language = language
        self._device = device
        self._dtype = dtype
        self._instruction = instruction
        self._model: Any | None = None
        self._load_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()

    async def warmup(self) -> None:
        """Load the model without performing speech synthesis."""
        await self._get_model()

    async def synthesize(self, text: str) -> SynthesizedSpeech:
        model = await self._get_model()
        try:
            async with self._inference_lock:
                generate = partial(
                    model.generate_custom_voice,
                    text=text,
                    language=self._language,
                    speaker=self._speaker,
                    instruct=self._instruction,
                )
                wavs, sample_rate = await asyncio.get_running_loop().run_in_executor(
                    _TTS_INFERENCE_EXECUTOR,
                    generate,
                )
        except Exception as error:
            raise TTSProviderError(
                "Qwen TTS inference failed.",
                phase="inference",
            ) from error

        if not wavs:
            raise TTSProviderError(
                "Qwen TTS returned no audio results.",
                phase="response",
            )

        try:
            wav = await asyncio.to_thread(
                self._encode_wav,
                wavs[0],
                sample_rate,
            )
        except Exception as error:
            raise TTSProviderError(
                "Qwen TTS audio encoding failed.",
                phase="encoding",
            ) from error

        if len(wav) <= 44:
            raise TTSProviderError(
                "Qwen TTS returned empty audio.",
                phase="response",
            )
        return SynthesizedSpeech(wav=wav)

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
            prepare_huggingface_environment()
            import torch
            from qwen_tts import Qwen3TTSModel

            dtype = resolve_torch_dtype(torch, self._device, self._dtype)
            LOGGER.info(
                "Loading Qwen TTS model model=%s device=%s dtype=%s "
                "qwen_tts=%s torch=%s torch_cuda=%s",
                self._model_name,
                self._device,
                str(dtype),
                installed_version("qwen-tts"),
                getattr(torch, "__version__", "unknown"),
                getattr(torch.version, "cuda", None),
            )
            model = Qwen3TTSModel.from_pretrained(
                self._model_name,
                device_map=self._device,
                dtype=dtype,
            )
            LOGGER.info(
                "Qwen TTS model loaded model=%s duration_ms=%.2f",
                self._model_name,
                (monotonic() - started_at) * 1_000,
            )
            return model
        except Exception as error:
            raise TTSProviderError(
                "Qwen TTS could not be loaded.",
                phase="load",
            ) from error

    @staticmethod
    def _encode_wav(samples: Any, sample_rate: int) -> bytes:
        import soundfile as sf

        output = BytesIO()
        sf.write(output, samples, sample_rate, format="WAV", subtype="PCM_16")
        return output.getvalue()


def resolve_torch_dtype(torch: Any, device: str, requested: str) -> Any:
    """Resolve an explicit or device-safe dtype without importing Torch in tests."""
    if requested != "auto":
        return getattr(torch, requested)

    if device.startswith("cuda"):
        if not torch.cuda.is_available():
            raise RuntimeError(
                f"TTS_DEVICE={device} was requested but CUDA is unavailable."
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
        raise RuntimeError(f"Invalid TTS CUDA device: {device}.") from error


def installed_version(package: str) -> str:
    try:
        return version(package)
    except PackageNotFoundError:
        return "unknown"
