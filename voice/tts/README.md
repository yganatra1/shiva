# Shiva TTS service

Internal, sentence-level text-to-speech for V0.3. The service accepts JSON text and returns PCM WAV. The production adapter lazy-loads `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`, defaults to English speaker `Aiden`, and uses a natural conversational instruction. Tests inject a fake and never load model weights. Voice cloning is intentionally absent.

Run from the repository root after installing the requirements:

```bash
python -m voice.tts.server
```

It binds to `127.0.0.1:8102` by default. `TTS_HOST`, `TTS_PORT`, `TTS_MODEL`, `TTS_SPEAKER`, `TTS_LANGUAGE`, and `TTS_DEVICE` are configurable. Do not publish this port; clients should use Shiva's `/voice/synthesize` gateway.
