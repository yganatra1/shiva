# Shiva V0.3

Shiva is Yash's private personal AI. V0.3 preserves the Fastify/Ollama streaming brain and V0.2 persistent memory, then adds a browser push-to-talk layer with internal Qwen ASR and TTS services.

## Architecture

```text
Text client  -> POST /chat -------┐
Voice UI     -> POST /voice/chat -┴-> shared ShivaChatService
                                      -> conversation + bounded working history
                                      -> embeddinggemma -> memory retrieval/ranking
                                      -> AIProvider -> Ollama/Gemma stream
                                      -> persistence + memory extraction

Voice UI -> /voice/transcribe -> internal Qwen ASR service
Voice UI <- /voice/synthesize -> internal Qwen TTS service
```

The API does not put model, embedding, or persistence details in route handlers. Provider and repository interfaces keep those boundaries explicit. `/chat` and `/voice/chat` share the same conversation, memory, persistence, cancellation, and model path; voice mode only adds speech-friendly response guidance. See [docs/memory-architecture.md](docs/memory-architecture.md) and [docs/voice-architecture.md](docs/voice-architecture.md).

V0.3 does not add wake words, always-listening mode, streaming ASR, VAD, barge-in, speaker recognition, face recognition, voice cloning, tools/browser access, authentication, cloud fallback, procedural memory, or a knowledge graph.

## Requirements

- Node.js 24 and npm
- Python 3.12 for the real ASR/TTS services
- ffmpeg for browser-audio normalization
- PostgreSQL with the pgvector extension available
- Ollama reachable at `OLLAMA_URL`
- the configured Gemma model and `embeddinggemma` installed for real `/chat` requests

Health, typechecking, building, and mocked Node/Python tests do not require Ollama, PostgreSQL, a GPU, or Qwen model weights.

## Environment

From the repository root:

```bash
cp .env.example .env
```

Configure these keys without committing `.env`:

```text
PORT=3000
HOST=127.0.0.1
OLLAMA_URL=http://127.0.0.1:11434
SHIVA_MODEL=gemma4:26b-a4b-it-q4_K_M
SHIVA_CONTEXT_LENGTH=16384
SHIVA_KEEP_ALIVE=30m
OLLAMA_REQUEST_TIMEOUT_MS=300000
DATABASE_URL=postgresql://shiva:change-me@127.0.0.1:5432/shiva
DATABASE_POOL_MAX=10
DATABASE_SSL=false
SHIVA_USER_ID=00000000-0000-4000-8000-000000000001
SHIVA_USER_NAME=Yash
EMBEDDING_MODEL=embeddinggemma
EMBEDDING_REQUEST_TIMEOUT_MS=60000
WORKING_MEMORY_MESSAGE_LIMIT=20
MEMORY_RETRIEVAL_LIMIT=8
ASR_SERVICE_URL=http://127.0.0.1:8101
TTS_SERVICE_URL=http://127.0.0.1:8102
ASR_MODEL=Qwen/Qwen3-ASR-0.6B
ASR_DEVICE=cuda:0
ASR_DTYPE=auto
TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
TTS_SPEAKER=Aiden
TTS_LANGUAGE=English
TTS_DEVICE=cuda:0
TTS_DTYPE=auto
HF_XET_HIGH_PERFORMANCE=0
ASR_REQUEST_TIMEOUT_MS=120000
TTS_REQUEST_TIMEOUT_MS=120000
SHIVA_PERF_LOG=false
NODE_ENV=development
```

`SHIVA_USER_ID` identifies the single Shiva owner and must remain stable across restarts. Use a strong database password in real environments. Node and both Python services deliberately resolve the root `.env`.

`SHIVA_KEEP_ALIVE` accepts Ollama duration strings such as `30m` or numeric seconds. Use `SHIVA_KEEP_ALIVE=-1` to keep the chat model loaded indefinitely; Shiva serializes numeric environment values as JSON numbers as required by Ollama.

## Local commands

Exact setup and verification commands:

```bash
cd /path/to/shiva
cp .env.example .env

cd app
npm install
npm test
npm run typecheck
npm run build
```

Run the CPU-safe Python route tests without installing Qwen or downloading weights:

```bash
cd ..
python3 -m venv /tmp/shiva-voice-tests
source /tmp/shiva-voice-tests/bin/activate
python -m pip install 'fastapi>=0.116,<1' 'httpx>=0.28,<1' 'python-dotenv>=1.1,<2' 'python-multipart>=0.0.20,<1'
python -m unittest voice.test_huggingface_runtime voice.asr.test_server voice.asr.test_qwen_provider voice.tts.test_server voice.tts.test_qwen_provider
deactivate
```

If a local PostgreSQL/pgvector database is available and `DATABASE_URL` is configured:

```bash
cd app
npm run db:migrate
npm start
```

For source-mode migration and hot reload:

```bash
npm run db:migrate:dev
npm run dev
```

Drizzle schema workflow after an intentional schema change:

```bash
npm run db:generate
npm run db:check
npm run typecheck
```

Review every generated SQL migration before committing it. `db:migrate` applies committed files from `app/drizzle/`; it does not generate schema changes at deployment time.

## API

Health is cheap and does not prove database, Ollama, or model availability:

```bash
curl http://127.0.0.1:3000/health
```

With the default model:

```json
{"status":"ok","name":"Shiva","version":"0.3.0","model":"gemma4:26b-a4b-it-q4_K_M"}
```

Start a streaming conversation:

```bash
curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Who are you and what is your purpose?"}'
```

The plain-text response streams as chunks arrive. Its `x-shiva-conversation-id` header contains the generated UUID. Reuse it for working-memory continuity:

```bash
curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Continue that thought.","conversationId":"PASTE-UUID-HERE"}'
```

`message` must contain 1–20,000 characters after whitespace validation. `conversationId` is optional but must be a UUID, and unknown fields are rejected. A valid UUID not owned by the configured user returns `CONVERSATION_NOT_FOUND`.

Errors before the first streamed chunk use a sanitized JSON envelope. Once streaming headers are committed, a later provider error closes the stream and is logged without exposing upstream response bodies, paths, credentials, or environment values.

### Voice

Open the lightweight browser UI after starting Shiva:

```text
http://127.0.0.1:3000/voice
```

The UI supports hold-to-talk, immediate transcription display, streamed response text, adaptive speech phrases, continuous Web Audio playback, stop speaking, typed fallback, new conversation, and automatic reuse of the existing conversation ID. A single synthesis worker prepares the next phrase while the current audio plays; Qwen TTS inference is never run concurrently by the browser queue.

Gateway endpoints:

- `POST /voice/transcribe` accepts a supported audio body such as `audio/webm` and returns `{ "text": "...", "language": "English" }`.
- `POST /voice/chat` has the same JSON body, streaming response, and `x-shiva-conversation-id` contract as `/chat`, but selects voice response style.
- `POST /voice/synthesize` accepts `{ "text": "..." }` and returns `audio/wav`.

The Python services remain internal. In two separate shells from the repository root, after installing their isolated requirements on the GPU host:

```bash
python3.12 -m venv .venv-asr
source .venv-asr/bin/activate
python -m pip install -r voice/asr/requirements.txt
python -m voice.asr.server
```

```bash
python3.12 -m venv .venv-tts
source .venv-tts/bin/activate
python -m pip install -r voice/tts/requirements.txt
python -m voice.tts.server
```

They bind only to `127.0.0.1:8101` and `127.0.0.1:8102` by default. Qwen adapters lazy-load on first inference. Installing requirements or running mock tests does not itself perform inference; do not expose either port publicly.

After both services are listening, preload their configured models sequentially:

```bash
echo "Warming ASR..."
curl -fsS -X POST http://127.0.0.1:8101/warmup
echo

echo "Warming TTS..."
curl -fsS -X POST http://127.0.0.1:8102/warmup
echo
```

Successful responses have the form `{"status":"ready","service":"asr|tts","model":"..."}`. Repeat warmup after every Python service restart. The endpoints load and cache model weights but do not run sample inference, so the first real request may still incur one-time inference initialization. Keep `GET /health` as the cheap liveness check; do not use warmup as a recurring health probe.

`ASR_DTYPE=auto` and `TTS_DTYPE=auto` use bfloat16 on Ampere-or-newer CUDA GPUs, float16 on older CUDA GPUs, and float32 when the corresponding device is `cpu`. Handled ASR/TTS load or inference failures are logged inside the owning Python process with their phase, duration, and complete causal traceback while public gateway responses remain sanitized. Both `/health` endpoints are process-liveness checks; successful model readiness is established by an inference or explicit model warm-up.

For a voice-service 503 on the GPU host, inspect the Python service log first. Then verify each isolated environment without downloading model weights:

```bash
source .venv-asr/bin/activate
python -c 'import torch, transformers; from importlib.metadata import version; from qwen_asr import Qwen3ASRModel; print("qwen-asr", version("qwen-asr"), "torch", torch.__version__, "torch-cuda", torch.version.cuda, "cuda-ready", torch.cuda.is_available(), "transformers", transformers.__version__)'
deactivate

source .venv-tts/bin/activate
python -c 'import torch, torchaudio, transformers; from importlib.metadata import version; from qwen_tts import Qwen3TTSModel; print("qwen-tts", version("qwen-tts"), "torch", torch.__version__, "torchaudio", torchaudio.__version__, "torch-cuda", torch.version.cuda, "cuda-ready", torch.cuda.is_available(), "transformers", transformers.__version__)'
deactivate

nvidia-smi
ollama ps
```

The Node gateway intentionally does not expose the Python traceback. Do not automatically fall back to CPU in production; use `ASR_DEVICE=cpu` or `TTS_DEVICE=cpu` only as an explicit diagnostic or deployment choice.

The voice providers discard an inherited `HF_HUB_ENABLE_HF_TRANSFER` value before importing Hugging Face because that legacy path is deprecated. Set `HF_XET_HIGH_PERFORMANCE=1` only when high-throughput Xet downloads are desired; otherwise leave the default disabled.

### Optional performance tracing

Set `SHIVA_PERF_LOG=true` and restart Shiva to emit one `[SHIVA PERF]` structured log for each `/chat` or `/voice/chat` request. It reports the database, working-memory, embedding, pgvector retrieval, ranking, prompt construction, Ollama TTFT/generation, persistence, and total timings in milliseconds. `pre-ollama` and `total-ttft` are elapsed from request entry; the other foreground stages are durations.

Deferred automatic memory work emits a separate `[SHIVA PERF ASYNC]` record with its queue delay and extraction duration. It is intentionally absent from `total-request`. Explicit `remember...` processing remains synchronous and appears as `explicit-memory` in the foreground record.

Disable tracing again with `SHIVA_PERF_LOG=false`; it is off by default.

Voice turns additionally emit `[SHIVA VOICE PERF]` with audio upload, ASR, voice-chat TTFT, first TTS request, TTS, and time-to-first-audio measurements. Every synthesized phrase emits `[SHIVA VOICE TTS PERF]` after playback with text length, text-ready/synthesis/playback timestamps, synthesis duration, generated audio duration, and real-time factor (`RTF = synthesis duration / audio duration`). Browser console warnings identify playback underruns over 50 ms.

For voice turns, deferred automatic memory extraction waits until the browser reports that queued speech playback is idle, with a 120-second fail-safe. Explicit `remember...` persistence remains synchronous and is never deferred behind playback.

## Current RunPod direct runtime

The current RunPod Pod does not run Docker Compose. Provision PostgreSQL with pgvector, Ollama, Gemma/embedding models, the two Python environments, Qwen voice models, ffmpeg, and `/workspace/shiva/repo/.env` separately. Do not overwrite the production `.env` during pulls.

```bash
cd /workspace/shiva/repo
git pull --ff-only

cd app
npm install
npm test
npm run typecheck
npm run build
npm run db:migrate
npm start
```

Then start ASR and TTS from two additional RunPod shells using the Python service commands above with repository path `/workspace/shiva/repo`. Keep both ports bound to localhost. From your browser, access only the Fastify port through the platform's private tunnel/proxy.

Before `/chat` verification, ensure the two configured models exist:

```bash
ollama pull embeddinggemma
ollama list
```

Then, from another shell, run the health and chat curls above. `npm start` is foreground execution; process supervision remains an operational choice. Keep runtime data outside Git, for example under `/workspace/shiva/{data,models,ollama,logs,backups,config}`.

Do not treat local mocked tests as RunPod integration proof. Real chat requires PostgreSQL/pgvector, the migration, Ollama, Gemma, and embeddinggemma. Real voice additionally requires ffmpeg, both Python services, their Qwen weights, and suitable GPU capacity.

## Future Docker runtime

The future Ubuntu/NVIDIA-server path is:

```text
Git -> Ubuntu NVIDIA server -> Docker Compose
```

The Compose definition runs the API, pgvector-enabled PostgreSQL, and internal ASR/TTS containers while leaving Ollama externally configurable. It publishes only the Shiva API; voice ports use the private Compose network. See [infra/README.md](infra/README.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Hot-reload the API from TypeScript |
| `npm test` | Run mocked memory, stream, cancellation, model-provider, and voice-gateway tests |
| `npm run typecheck` | Strict-check app and tests without emitting |
| `npm run build` | Compile ESM output into `app/dist` |
| `npm run db:generate` | Generate a migration from the Drizzle schema |
| `npm run db:check` | Validate Drizzle migration metadata |
| `npm run db:migrate:dev` | Apply migrations from TypeScript |
| `npm run db:migrate` | Apply migrations from compiled output |
| `npm start` | Run the compiled API |
