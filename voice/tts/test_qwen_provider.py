import asyncio
import unittest

from voice.tts.provider import TTSProviderError
from voice.tts.qwen_provider import QwenTTSProvider, resolve_torch_dtype


class FakeCuda:
    def __init__(self, available: bool, capability: tuple[int, int]) -> None:
        self._available = available
        self._capability = capability
        self.requested_device: int | None = None

    def is_available(self) -> bool:
        return self._available

    def get_device_capability(self, device: int) -> tuple[int, int]:
        self.requested_device = device
        return self._capability


class FakeTorch:
    bfloat16 = "bfloat16"
    float16 = "float16"
    float32 = "float32"

    def __init__(self, cuda: FakeCuda) -> None:
        self.cuda = cuda


class FailingInferenceModel:
    def generate_custom_voice(self, **_arguments: object) -> object:
        raise RuntimeError("synthetic inference failure")


class EmptyResultModel:
    def generate_custom_voice(self, **_arguments: object) -> tuple[list[object], int]:
        return [], 24_000


class QwenTTSProviderTest(unittest.TestCase):
    def test_auto_dtype_uses_bfloat16_on_ampere_cuda(self) -> None:
        cuda = FakeCuda(available=True, capability=(8, 6))
        torch = FakeTorch(cuda)

        dtype = resolve_torch_dtype(torch, "cuda:1", "auto")

        self.assertEqual(dtype, "bfloat16")
        self.assertEqual(cuda.requested_device, 1)

    def test_auto_dtype_is_safe_for_cpu_and_older_cuda(self) -> None:
        cpu_torch = FakeTorch(FakeCuda(available=False, capability=(0, 0)))
        older_cuda_torch = FakeTorch(FakeCuda(available=True, capability=(7, 5)))

        self.assertEqual(resolve_torch_dtype(cpu_torch, "cpu", "auto"), "float32")
        self.assertEqual(
            resolve_torch_dtype(older_cuda_torch, "cuda", "auto"),
            "float16",
        )

    def test_requested_cuda_must_be_available(self) -> None:
        torch = FakeTorch(FakeCuda(available=False, capability=(0, 0)))

        with self.assertRaisesRegex(RuntimeError, "CUDA is unavailable"):
            resolve_torch_dtype(torch, "cuda:0", "auto")

    def test_inference_failure_is_phase_classified(self) -> None:
        provider = QwenTTSProvider("mock-model", device="cpu")
        provider._model = FailingInferenceModel()

        with self.assertRaises(TTSProviderError) as caught:
            asyncio.run(provider.synthesize("Hello"))

        self.assertEqual(caught.exception.phase, "inference")

    def test_empty_result_is_response_failure(self) -> None:
        provider = QwenTTSProvider("mock-model", device="cpu")
        provider._model = EmptyResultModel()

        with self.assertRaises(TTSProviderError) as caught:
            asyncio.run(provider.synthesize("Hello"))

        self.assertEqual(caught.exception.phase, "response")


if __name__ == "__main__":
    unittest.main()
