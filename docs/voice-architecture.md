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
  └─ complete sentences ───── POST /voice/synthesize ── internal TTS :8102
```

`/chat` and `/voice/chat` use the same validation, streaming transport, conversation ID contract, cancellation flow, `ShivaChatService`, memory pipeline, and model provider. Their only intentional difference is interaction mode. Voice mode adds a system-level response-style instruction asking for concise, conversational, speech-friendly output without unnecessary markdown. It does not alter or bypass the main Shiva system prompt.

The browser stores `x-shiva-conversation-id` in `sessionStorage`, sends it as the existing `conversationId` field on later `/voice/chat` calls, and clears it for **New conversation**. There is no second session implementation.

## ASR boundary

The internal FastAPI ASR service defaults to `127.0.0.1:8101`. `POST /transcribe` accepts multipart audio. Every upload, including WebM/Opus, is decoded by ffmpeg and normalized to mono 16 kHz PCM WAV before the `ASRProvider` sees it. The production adapter lazy-loads `Qwen/Qwen3-ASR-0.6B`; tests use a fake provider.

## TTS boundary

The internal FastAPI TTS service defaults to `127.0.0.1:8102`. `POST /synthesize` accepts `{ "text": "..." }` and returns `audio/wav`. The production adapter lazy-loads `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`, defaults to English and `Aiden`, and supplies a natural conversational instruction. Voice cloning is absent.

As `/voice/chat` text streams into the browser, complete sentences are queued for TTS immediately. Synthesis is sentence-level rather than true audio streaming: requests are serialized, ready WAV segments are played in order, and the final incomplete sentence is flushed when generation ends.

## Security and failures

ASR and TTS bind to localhost by default and must not have public host ports. The browser talks only to Fastify. The gateway applies upload limits, request timeouts, caller cancellation, response-shape checks, and safe public errors: `INVALID_AUDIO`, `ASR_UNAVAILABLE`, and `TTS_UNAVAILABLE`. Internal URLs, response bodies, stacks, and model details are not returned to clients.

## Performance tracing

When `SHIVA_PERF_LOG=true`, the existing chat log remains available and a correlated `[SHIVA VOICE PERF]` record reports `audio-upload`, `asr-duration`, `chat-ttft`, `first-tts-request`, `tts-duration`, and `time-to-first-audio`. The UI supplies an observability-only UUID header per voice turn. It is not a conversation or authentication identifier. Time to first audio ends when the gateway has the first WAV ready; browser autoplay policy and device playback latency are outside that measurement.

## Deliberate V0.3 limits

No wake word, always-listening mode, streaming ASR, VAD, barge-in, speaker recognition, face recognition, voice cloning, Gujarati/Hindi TTS, tools/internet access, or replacement of Gemma is included.

Qwen adapter calls follow the official [Qwen3-ASR package API](https://github.com/QwenLM/Qwen3-ASR) and [Qwen3-TTS CustomVoice model API](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice).
