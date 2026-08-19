# Shiva V0.3 voice architecture

Voice is an input/output layer around the existing Shiva brain. It does not own conversations, memory, prompts, or model inference.

```text
Browser GET /voice
  ├─ microphone recording (MediaRecorder, push-to-talk)
  ├─ POST /voice/transcribe ── Fastify gateway ── internal ASR :8101
  ├─ POST /voice/chat ──────── shared ShivaChatService
  │                            ├─ conversation + working memory
  │                            ├─ semantic/episodic retrieval
  │                            ├─ AIProvider / Gemma streaming
  │                            └─ message persistence + memory extraction
  └─ adaptive speech phrases ─ POST /voice/synthesize ── internal TTS :8102
       └─ persistent Web Audio timeline
```

`/chat` and `/voice/chat` use the same validation, streaming transport, conversation ID contract, cancellation flow, `ShivaChatService`, memory pipeline, and model provider. Their only intentional difference is interaction mode. Voice mode adds a system-level response-style instruction asking for concise, conversational, speech-friendly output without unnecessary markdown. It does not alter or bypass the main Shiva system prompt.

The browser stores `x-shiva-conversation-id` in `sessionStorage`, sends it as the existing `conversationId` field on later `/voice/chat` calls, and clears it for **New conversation**. There is no second session implementation.

## ASR boundary

The internal FastAPI ASR service defaults to `127.0.0.1:8101`. `POST /transcribe` accepts multipart audio. Every upload, including WebM/Opus, is decoded by ffmpeg and normalized to mono 16 kHz PCM WAV before the `ASRProvider` sees it. The production adapter lazy-loads `Qwen/Qwen3-ASR-0.6B`; tests use a fake provider.

The ASR process logs model-load and inference failures with a phase, elapsed time, and chained traceback, but returns only a generic 503 to the gateway. Valid audio with no recognizable speech is classified as invalid input instead of model unavailability. `GET /health` is deliberately liveness-only because the model is lazy-loaded. Internal `POST /warmup` synchronously loads and caches the configured model through `ASRProvider`; it performs no transcription and returns readiness only after loading succeeds.

## TTS boundary

The internal FastAPI TTS service defaults to `127.0.0.1:8102`. `POST /synthesize` accepts `{ "text": "..." }` and returns `audio/wav`. The production adapter lazy-loads `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`, defaults to English and `Aiden`, and supplies a natural conversational instruction. Voice cloning is absent.

Like ASR, TTS logs phase-aware load/inference failures and their chained traceback only inside its private service while returning a sanitized 503 through Fastify. Its health endpoint is also liveness-only while the model remains lazy-loaded. Internal `POST /warmup` synchronously loads and caches the configured model through `TTSProvider` without generating sample speech.

Both warmup operations are idempotent and concurrency-safe. They should be called sequentially after each voice-service restart, not used as recurring health probes. A successful warmup removes lazy weight-loading latency but does not prove the complete audio pipeline or eliminate every first-inference CUDA/kernel initialization cost.

As `/voice/chat` text streams into the browser, an adaptive chunker emits a smaller first phrase, combines tiny sentences, and uses moderately larger later phrases. One synthesis worker keeps Qwen generation strictly serial while running independently from playback, allowing phrase N+1 to generate while phrase N plays. The final incomplete phrase is flushed exactly once.

Each complete WAV is decoded once and scheduled as an `AudioBufferSourceNode` on a persistent `AudioContext` timeline. Ready buffers are placed in order with a small boundary overlap and silent edges are conservatively trimmed. This removes the decode/source-switch pause caused by replacing one HTML audio element for every sentence. The HTML audio path remains only as a compatibility fallback. If TTS real-time factor is 1 or higher, the queue can still underrun; genuinely gap-free low-latency playback then requires faster or truly streaming TTS inference.

The browser reports scheduled, started, ended, and whole-turn idle playback events to the internal Fastify route. Deferred automatic memory extraction for a voice turn waits for whole-turn idle, with a bounded timeout so abandoned tabs cannot block it indefinitely. Explicit memory requests remain synchronous and unchanged.

## Security and failures

ASR and TTS bind to localhost by default and must not have public host ports. The browser talks only to Fastify. The gateway applies upload limits, request timeouts, caller cancellation, response-shape checks, and safe public errors: `INVALID_AUDIO`, `ASR_UNAVAILABLE`, and `TTS_UNAVAILABLE`. Internal URLs, response bodies, stacks, and model details are not returned to clients.

## Performance tracing

When `SHIVA_PERF_LOG=true`, the existing chat log remains available and a correlated `[SHIVA VOICE PERF]` record reports `audio-upload`, `asr-duration`, `chat-ttft`, `first-tts-request`, `tts-duration`, and `time-to-first-audio`. Each phrase also emits `[SHIVA VOICE TTS PERF]` with text length, text-ready time, synthesis start/end and duration, generated WAV duration, RTF, and browser playback scheduled/start/end timestamps. The UI supplies an observability-only UUID header per voice turn. It is not a conversation or authentication identifier. Client and server timestamps are Unix milliseconds but can reflect clock skew between the browser device and Shiva host.

## Deliberate V0.3 limits

No wake word, always-listening mode, streaming ASR, VAD, barge-in, speaker recognition, face recognition, voice cloning, Gujarati/Hindi TTS, tools/internet access, or replacement of Gemma is included.

Qwen adapter calls follow the official [Qwen3-ASR package API](https://github.com/QwenLM/Qwen3-ASR) and [Qwen3-TTS CustomVoice model API](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice).
