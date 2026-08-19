# Shiva ASR service

Internal, non-streaming speech recognition for the V0.3 push-to-talk flow. The service accepts a multipart `file`, normalizes it with ffmpeg to mono 16 kHz PCM WAV, and then calls the injected `ASRProvider`. The production adapter lazy-loads `Qwen/Qwen3-ASR-0.6B`; tests inject a fake and never load model weights.

Run from the repository root after installing the requirements and ensuring `ffmpeg` is available:

```bash
python -m voice.asr.server
```

It binds to `127.0.0.1:8101` by default. `ASR_HOST`, `ASR_PORT`, `ASR_MODEL`, `ASR_DEVICE`, and `ASR_DTYPE` are configurable. `ASR_DTYPE=auto` selects bfloat16 on an Ampere-or-newer CUDA GPU and float32 on CPU. Install ffmpeg, SoX, and libsndfile on a direct host. Do not publish this port; clients should use Shiva's `/voice/transcribe` gateway.

`GET /health` is a cheap process-liveness check. After each service restart, synchronously load the configured model and wait for readiness with:

```bash
curl -fsS -X POST http://127.0.0.1:8101/warmup
echo
```

Warmup is idempotent and does not transcribe sample audio. It may download uncached weights and removes lazy model-loading time, but the first real transcription can still pay one-time inference or CUDA initialization costs.

The provider discards an inherited `HF_HUB_ENABLE_HF_TRANSFER` value before importing Hugging Face. Set `HF_XET_HIGH_PERFORMANCE=1` only when high-throughput Xet downloads are desired and supported by the installed Hub version.
