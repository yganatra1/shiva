import asyncio
import threading
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


class CancellationOverlapModel:
    def __init__(self) -> None:
        self.first_started = threading.Event()
        self.second_started = threading.Event()
        self.release_first = threading.Event()
        self._state_lock = threading.Lock()
        self._active = 0
        self.max_active = 0

    def generate_custom_voice(
        self,
        *,
        text: str,
        **_arguments: object,
    ) -> tuple[list[object], int]:
        with self._state_lock:
            self._active += 1
            self.max_active = max(self.max_active, self._active)

        try:
            if text == "first":
                self.first_started.set()
                if not self.release_first.wait(timeout=2):
                    raise RuntimeError("Timed out waiting to release first inference.")
            else:
                self.second_started.set()
            return [object()], 24_000
        finally:
            with self._state_lock:
                self._active -= 1


class LoadCountingProvider(QwenTTSProvider):
    def __init__(self) -> None:
        super().__init__("mock-model", device="cpu")
        self.load_calls = 0

    def _load_model(self) -> object:
        self.load_calls += 1
        return object()


class TestEncodingProvider(QwenTTSProvider):
    @staticmethod
    def _encode_wav(_samples: object, _sample_rate: int) -> bytes:
        return b"RIFF" + (b"\x00" * 4) + b"WAVE" + (b"\x00" * 36)


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

    def test_warmup_loads_once_without_running_inference(self) -> None:
        provider = LoadCountingProvider()

        async def warm_twice_concurrently() -> None:
            await asyncio.gather(provider.warmup(), provider.warmup())
            await provider.warmup()

        asyncio.run(warm_twice_concurrently())

        self.assertEqual(provider.load_calls, 1)

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

    def test_cancelled_request_cannot_overlap_following_inference(self) -> None:
        model = CancellationOverlapModel()
        provider = TestEncodingProvider("mock-model", device="cpu")
        provider._model = model

        async def cancel_then_start_another() -> None:
            first = asyncio.create_task(provider.synthesize("first"))
            second = None
            try:
                first_started = await asyncio.to_thread(
                    model.first_started.wait,
                    1,
                )
                self.assertTrue(first_started)

                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first

                second = asyncio.create_task(provider.synthesize("second"))
                await asyncio.sleep(0.05)
                self.assertFalse(
                    model.second_started.is_set(),
                    "Second inference overlapped the cancelled worker thread.",
                )
            finally:
                model.release_first.set()
                if second is None:
                    await asyncio.gather(first, return_exceptions=True)
                else:
                    await asyncio.gather(
                        first,
                        second,
                        return_exceptions=True,
                    )

            self.assertTrue(model.second_started.is_set())
            self.assertEqual(model.max_active, 1)

        asyncio.run(cancel_then_start_another())


if __name__ == "__main__":
    unittest.main()
