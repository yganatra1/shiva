# Shiva V0.3 voice architecture

Voice is an input/output layer around the existing Shiva brain. It does not own conversations, memory, prompts, or model inference.

```text
Browser GET /voice
  └─ one WebSocket /voice/chat
       ⇅ session / turn control JSON
       ⇅ microphone bytes (binary)
       ⇅ speech audio frames (binary PCM16 or WAV)
            │
            ▼
       VoiceSession orchestrator
            ├── ASR (internal Qwen service :8101)
            ├── ShivaChatService / Gemma stream
            ├── StreamingSpeechChunker
            ├── SpeechSynthesisQueue (serial TTS)
            └── TTS (internal Qwen service :8102)
                 └─ WAV → strip to PCM16 when possible → binary WS frames
```

The browser keeps a single persistent voice connection. It never calls `/voice/synthesize` or `/voice/transcribe` for the live UI. Those REST endpoints remain for diagnostics and benchmarks only. `POST /voice/chat` remains as a diagnostic text-streaming endpoint with voice response guidance; realtime voice turns use the WebSocket upgrade on the same path.

`/chat` and the voice session both use `ShivaChatService`, conversation IDs, working memory, semantic/episodic retrieval, persistence, cancellation, and the same Gemma provider. Voice mode only adds a system-level speech-friendly response style instruction.

The browser stores the conversation ID in `sessionStorage`, sends it on `session_start` after reconnect, and clears it for **New conversation**. There is no second AI conversation implementation.

## WebSocket protocol

Control messages are JSON. Audio is never base64.

**Client → server**

| type | role |
| --- | --- |
| `session_start` | open/resume; optional `conversationId` |
| `user_text` | typed turn |
| `audio_start` / binary frames / `audio_end` | push-to-talk mic capture |
| `interrupt` | stop speaking / cancel active turn |
| `playback` | browser telemetry (`received`, `scheduled`, `started`, `ended`, `underrun`, `idle`) |
| `session_end` | close the socket |

**Server → client**

| type | role |
| --- | --- |
| `session_ready` | protocol version, conversation id, preferred `pcm16` |
| `transcript_partial` / `transcript_final` | ASR result |
| `assistant_text_delta` / `assistant_text_done` | streamed Gemma text |
| `audio_start` / `audio_end` | speech frame boundaries |
| `turn_done` | `completed` / `interrupted` / `error` |
| `error` | safe public error codes |

Binary speech frames use a fixed 24-byte little-endian header (`SHVA` magic, version, format, channels, sample rate, turn sequence, chunk id, audio duration ms) followed by PCM16 or WAV bytes.

## Speech pipeline

Gemma already streams. As soon as the chunker has a natural first phrase (roughly 40–80 characters), the server enqueues TTS while generation continues. Later phrases target roughly 100–200 characters at sentence/clause boundaries. Tiny fragments are not synthesized alone.

Only one Qwen TTS inference runs at a time. While the browser plays chunk N, the server synthesizes N+1 and pushes completed audio immediately. Qwen itself remains batch-per-chunk; the architecture streams each finished chunk, it does not pretend the model is token-streaming audio.

The browser keeps one `AudioContext`, decodes PCM synchronously when possible, and schedules `AudioBufferSourceNode`s on a continuous timeline so ordinary multi-sentence answers play without artificial JS gaps when TTS stays ahead of playback.

## Interruption

`interrupt`, a new user turn, or disconnect abandons the active turn: abort Gemma, cancel the TTS queue, bump turn generation so stale frames never emit, and stop browser playback. Turn IDs and monotonic turn sequences keep old audio/text from leaking into a newer turn.

## Memory gating

Deferred automatic memory extraction waits until the browser reports playback `idle` for that turn (or the session closes / a bounded fail-safe expires). Explicit “remember this” persistence stays synchronous and is never deferred behind playback.

## ASR / TTS boundaries

Unchanged internal FastAPI services:

- ASR `:8101` — multipart audio, ffmpeg normalize to mono 16 kHz WAV, `Qwen3-ASR-0.6B`
- TTS `:8102` — `{ "text": "..." }` → `audio/wav`, `Qwen3-TTS-12Hz-0.6B-CustomVoice`

Both bind to localhost. The browser talks only to Fastify. Warmup endpoints remain available after each Python restart.

## Performance tracing

With `SHIVA_PERF_LOG=true`, each turn emits `[SHIVA VOICE PERF]` (`audio-upload`, `asr-duration`, `chat-ttft`, `first-tts-request`, `tts-duration`, `time-to-first-audio`) and each speech chunk emits `[SHIVA VOICE TTS PERF]` with text length, queue/synthesis/websocket/receive/playback timestamps, synthesis duration, audio duration, RTF, decode duration, and underrun ms.

## Deliberate V0.3 limits

The voice layer itself adds no wake word, always-listening mode, streaming ASR, VAD, barge-in, speaker recognition, face enrollment, voice cloning, Gujarati/Hindi TTS, tools/internet access, or replacement of Gemma. Face recognition is a separate local identity subsystem used for uploaded photos and explicit device-camera captures.

Qwen TTS remains batch-per-request: one completed WAV (then PCM strip) per speech chunk. Truly streaming TTS inference is out of scope for this architecture pass.
