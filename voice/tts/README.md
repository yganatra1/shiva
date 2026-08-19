# Shiva TTS service

Internal, sentence-level text-to-speech for V0.3. The service accepts JSON text and returns PCM WAV. The production adapter lazy-loads `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`, defaults to English speaker `Aiden`, and uses a natural conversational instruction. Tests inject a fake and never load model weights. Voice cloning is intentionally absent.

Run from the repository root after installing the requirements:

```bash
python -m voice.tts.server
```

It binds to `127.0.0.1:8102` by default. `TTS_HOST`, `TTS_PORT`, `TTS_MODEL`, `TTS_SPEAKER`, `TTS_LANGUAGE`, `TTS_DEVICE`, and `TTS_DTYPE` are configurable. `TTS_DTYPE=auto` selects bfloat16 on an Ampere-or-newer CUDA GPU and float32 on CPU. Install SoX and libsndfile on a direct host. Do not publish this port; clients should use Shiva's `/voice/synthesize` gateway.

`GET /health` is a cheap process-liveness check. After each service restart, synchronously load the configured model and wait for readiness with:

```bash
curl -fsS -X POST http://127.0.0.1:8102/warmup
echo
```

Warmup is idempotent and does not synthesize sample speech. It may download uncached weights and removes lazy model-loading time, but the first real synthesis can still pay one-time inference or CUDA initialization costs.

The provider discards an inherited `HF_HUB_ENABLE_HF_TRANSFER` value before importing Hugging Face. Set `HF_XET_HIGH_PERFORMANCE=1` only when high-throughput Xet downloads are desired and supported by the installed Hub version.
