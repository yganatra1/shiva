# Shiva V0.3

Shiva is Yash's private personal AI. V0.3 preserves the Fastify/Ollama streaming brain, V0.2 persistent memory, and browser voice layer, then adds a bounded agent loop, durable `SAFE`/`AUTO`/`FULL_ACCESS` execution modes, and expense, public-web, and read-only Shiva-workspace skills.

## Architecture

```text
Text client  -> POST /chat ----------------┐
Voice UI     -> WS   /voice/chat ----------┴-> shared ShivaChatService
                                              -> conversation + bounded working history
                                              -> embeddinggemma -> memory retrieval/ranking
                                              -> semantic planner (every ordinary turn)
                                                   -> direct_chat -> Ollama/Gemma stream
                                                   -> capability summary / clarification
                                                   -> frozen pack scope -> action metadata
                                                      -> execution policy / exact confirmation
                                                      -> SkillExecutor -> sheet/web tools
                                              -> persistence + memory extraction
                 VoiceSession also owns:
                   ASR -> chunker -> serial Qwen TTS -> binary audio frames
```

The API does not put model, embedding, persistence, or external-service details in route handlers. Provider and repository interfaces keep those boundaries explicit. `/chat` and the voice WebSocket share the same conversation, memory, persistence, cancellation, and model path; voice mode only adds speech-friendly response guidance. Every non-explicit-memory turn reaches the semantic planner after the same context is built. The planner decides from the registered catalog whether to use skills, ask a clarification, describe the real catalog, or delegate tool-free conversation to the existing streaming provider. There is no keyword/regex intent router.

Google Sheets is the sole expense source of truth. Shiva does not maintain a PostgreSQL expense ledger, row cache, or synchronization mirror. PostgreSQL stores the existing conversation/memory data, the per-user Google resource binding and provisioning lease, durable execution settings and action-bound confirmations, plus `agent_runs` and `skill_runs` audit records. Expense-routed audit payloads are redacted so those audit tables do not duplicate ledger details; the normal chat transcript and memory pipeline remain unchanged and can still contain what the user said. See [docs/memory-architecture.md](docs/memory-architecture.md), [docs/voice-architecture.md](docs/voice-architecture.md), and [docs/agent-architecture.md](docs/agent-architecture.md).

V0.3 does not add wake words, always-listening mode, streaming ASR, VAD, barge-in, speaker recognition, face recognition, voice cloning, authentication, cloud fallback, procedural memory, a knowledge graph, arbitrary browser automation, or a general-purpose shell/tool runtime.

The official Android companion lives in [`android/`](android/README.md). It is a native Kotlin client over Tailscale, not a second brain.

## Requirements

- Node.js 24 and npm
- Python 3.12 for the real ASR/TTS services
- ffmpeg for browser-audio normalization
- PostgreSQL with the pgvector extension available
- Ollama reachable at `OLLAMA_URL`
- the configured Gemma model and `embeddinggemma` installed for real `/chat` requests
- for expense skills: Google user OAuth credentials with the least-privilege `drive.file` scope (recommended), or a legacy pre-existing Sheet shared with a service account
- for web research: a Brave Search API key

Health, typechecking, building, and mocked Node/Python tests do not require Ollama, PostgreSQL, Google Sheets, Brave Search, a GPU, or Qwen model weights. Mocked tests are not proof of a live Google, Brave, Ollama, or RunPod integration.

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
SHIVA_TIME_ZONE=Asia/Kolkata
AGENT_MAX_STEPS=12
AGENT_REQUEST_TIMEOUT_MS=300000
SHIVA_MAX_EXECUTION_MODE=FULL_ACCESS
SHIVA_CONFIRMATION_TTL_MS=300000
EXPENSE_SHEET_ID=
EXPENSE_SHEET_REQUEST_TIMEOUT_MS=15000
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
GOOGLE_APPLICATION_CREDENTIALS=
BRAVE_SEARCH_API_KEY=
BRAVE_SEARCH_URL=https://api.search.brave.com
WEB_REQUEST_TIMEOUT_MS=15000
WEB_MAX_CONTENT_BYTES=524288
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

`SHIVA_MAX_EXECUTION_MODE` is the host-controlled authority ceiling and accepts `SAFE`, `AUTO`, or `FULL_ACCESS`. The current mode itself is stored in PostgreSQL so conversational changes survive restarts. Effective authority is the lower of the stored mode and this configured maximum; lockdown forces the effective mode to `SAFE`. `SHIVA_CONFIRMATION_TTL_MS` controls how long an exact pending action can be approved and defaults to 300,000 ms (five minutes).

The initial database state is `AUTO` with lockdown disabled. Lowering authority and entering lockdown are immediate. Raising authority, leaving lockdown, and sensitive/destructive operations require an exact action-bound confirmation. Settings carry a monotonic revision: control changes commit with compare-and-set, confirmations are bound to the revision they were created under, and writes recheck state immediately before starting. This is intentionally not an internal permission matrix: Google OAuth scopes, cloud IAM, operating-system permissions, and registered adapters remain the actual capability boundary.

The domain skill contracts include `record_expense`, `expense_report`, `web_research`, `learn_about_shiva`, and `workspace_terminal`. Runtime-owned `get_execution_mode`, `set_execution_mode`, and `set_lockdown` controls expose execution state without giving Gemma direct database access. Expense execution is enabled by the complete `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`/`GOOGLE_OAUTH_REFRESH_TOKEN` trio, or by the legacy `EXPENSE_SHEET_ID` path. If neither is configured, expense skills return `EXPENSE_SHEET_UNAVAILABLE`. Partial OAuth configuration is rejected at startup. `GOOGLE_APPLICATION_CREDENTIALS` is used only by the legacy sheet-ID path. Without `BRAVE_SEARCH_API_KEY`, research returns `WEB_RESEARCH_UNAVAILABLE`. The two workspace skills are always configured because they operate locally inside this repository. `AGENT_MAX_STEPS` and `AGENT_REQUEST_TIMEOUT_MS` bound the complete planner/tool run.

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

The execution-mode migration creates the revisioned singleton `system_settings` row, persistent action confirmations with one-shot execution lifecycle state, and the execution-mode/action-classification fields on `skill_runs`. Apply committed migrations before starting the updated API:

```bash
cd app
npm install
npm run build
npm run db:migrate
npm start
```

## API

Health is cheap and does not prove database, Ollama, or model availability:

```bash
curl http://127.0.0.1:3000/health
```

With the default model:

```json
{"status":"ok","name":"Shiva","version":"0.3.0","model":"gemma4:26b-a4b-it-q4_K_M"}
```

Read the durable execution state separately:

```bash
curl http://127.0.0.1:3000/settings/execution
```

A state with no pending confirmation has this shape:

```json
{
  "executionMode": "AUTO",
  "maxExecutionMode": "FULL_ACCESS",
  "effectiveExecutionMode": "AUTO",
  "lockdown": false,
  "updatedAt": "2026-08-22T10:00:00.000Z",
  "updatedBy": null,
  "pendingConfirmation": null
}
```

When present, `pendingConfirmation` is a sanitized summary of the exact action awaiting approval, including its identifier, skill, reason, safe arguments, and expiry. The stored action is additionally bound to the current settings revision, but that internal compare-and-set value is not exposed by the endpoint. This endpoint is read-only and never returns executable raw arguments. Unlike the cheap `/health` probe, it reads persistent execution state.

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

### Agent skills

Expense, web, and ordinary questions use the same `/chat` or voice conversation contract. Every non-explicit-memory turn first gives the planner the actual registered skill catalog, including whether each external integration is configured. The planner can delegate tool-free conversation back to the existing streaming path, request one clarification, return a registry-derived capability summary, or make a skill call. Its first skill call declares the complete minimal skill set for the original task. The agent loop validates and freezes that set; later decisions may only use that exact scope, so web pages and tool observations cannot add a new capability mid-run. A malformed or conflicting planner decision is rejected internally and returned to the planner as precise corrective feedback; Shiva continues the same bounded run without executing the rejected action.

Execution controls use the same conversation path. Useful manual checks include:

```text
What execution mode are you currently using?
Go into safe mode.
Switch back to full access.
Yes.
Shiva, lockdown.
Disable lockdown and return to full access.
Yes.
```

Moving to a lower mode and entering lockdown happen immediately. Moving to a higher mode and leaving lockdown produce an exact pending confirmation; the following approval applies only to that stored action and expires after `SHIVA_CONFIRMATION_TTL_MS`. Approval is atomically claimed before execution, cannot be replayed, and becomes stale if settings or the action's risk classification change. Successful claimed actions finish as `EXECUTED`; failed or invalidated claims finish as `FAILED`. If `SHIVA_MAX_EXECUTION_MODE=AUTO`, a request for `FULL_ACCESS` is rejected regardless of model output or database contents.

Record an expense:

```bash
curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Record ₹450 for pizza as dinner."}'
```

Read fresh sheet rows and calculate totals by currency:

```bash
curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"How much have I spent today?"}'
```

Research current public information:

```bash
curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Research current RTX 3090 rental pricing and cite the sources."}'
```

Inspect Shiva itself or diagnose its implementation:

```bash
curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Inspect your current skill and execution architecture. How are actions classified under the global execution modes?"}'
```

`learn_about_shiva` returns a bounded repository tree plus excerpts from core project documentation. `workspace_terminal` is the deeper inspection capability: Shiva can iteratively run `pwd`, `ls`, `rg`, `cat`, `head`, `tail`, `wc`, and read-only `git status|ls-files|diff|log|grep` operations, observe each result, and choose the next inspection step. It can read repository source and documentation, including hidden and ignored files, but cannot escape the repository through paths or symlinks. A shared case-insensitive boundary denies `.env*` other than `.env.example` and conventional credential, token, password, and private-key files or stores for both direct reads and recursive content searches; other repository content remains available for self-inspection and evolution. It receives no shell, stdin, redirection, interpreter, network command, or mutating command; child processes have a deadline and output cap. PostgreSQL audit records retain bounded command arguments and safe rejection diagnostics for troubleshooting, while successful terminal output remains redacted.

There is no terminal write/update/delete capability in V0.3. This remains true even in `FULL_ACCESS`: an execution mode cannot create a capability that the registered adapter and operating-system user do not have. If workspace mutation is added later, clearly requested ordinary writes will follow the global mode policy and only genuinely sensitive operations will require one exact persisted confirmation. Model text is never a substitute for runtime approval.

With the recommended user OAuth setup, the first expense read or write lazily creates one spreadsheet per Shiva user in that Google user's My Drive. A first `expense_report` that must provision or upgrade resources is therefore classified as a normal write before policy evaluation; after the binding is ready, reports are normal reads. Shiva names the spreadsheet `Shiva Expenses`, creates an `Expenses` tab, freezes row 1, and owns the internal `Expenses!A:G` layout. The user does not create a sheet, choose a tab, or configure a range. The managed header is:

```text
expense_id | occurred_at | amount | currency | description | category | source
```

Recommended Google setup:

1. In a Google Cloud project, enable the Google Sheets API, configure an OAuth consent screen, and create an OAuth 2.0 client. Google's [Sheets creation guide](https://developers.google.com/workspace/sheets/api/guides/create) describes the API resource Shiva provisions.
2. Complete a one-time user consent flow requesting offline access and only `https://www.googleapis.com/auth/drive.file`; retain the resulting refresh token securely. Use Google's [OAuth offline-access flow](https://developers.google.com/identity/protocols/oauth2/web-server) and [Sheets scope reference](https://developers.google.com/workspace/sheets/api/scopes) as the authority for the bootstrap process.
3. Put the client ID, client secret, and refresh token in `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN`. Leave `EXPENSE_SHEET_ID` and `GOOGLE_APPLICATION_CREDENTIALS` empty for autonomous creation.
4. Apply the committed database migrations before startup:

   ```bash
   cd app
   npm install
   npm run build
   npm run db:migrate
   npm start
   ```

5. Make the first expense request. Shiva creates and initializes the sheet, verifies it, and durably binds its Google resource IDs to `SHIVA_USER_ID`.

The app never needs or asks for the user's Google password or unrestricted account credentials. It consumes an already-authorized refresh token and does not currently expose an OAuth enrollment/callback UI. Keep the OAuth client secret and refresh token outside Git, logs, prompts, and the database. If the OAuth consent screen is External and remains in Google Cloud's Testing status, Google may issue a refresh token that expires after seven days; use the appropriate published consent state for a stable deployment.

`EXPENSE_SHEET_ID` plus `GOOGLE_APPLICATION_CREDENTIALS` remains only as a legacy/manual-adoption path. In that mode an operator creates and shares a spreadsheet with the service-account email as Editor, then supplies its ID. During first adoption Shiva can add a missing `Expenses` tab, initialize an empty header, and freeze row 1; it rejects a populated noncanonical layout rather than overwriting data. A configured bootstrap ID that differs from the durable binding fails closed instead of silently switching ledgers. Supplying any but not all three OAuth values is also rejected at startup.

Every expense report reads the live sheet and computes fixed two-decimal totals per currency across every matching row; it performs no currency conversion. Its 1–25 `limit` (default 25) and 8,000-character serialized detail budget cap only the individual rows exposed to the planner, while `matchedCount` and totals still cover the full filtered result. Every record operation validates the current header, appends one A:G row, reads the exact appended range back, and reports success only if all seven cells match. `expense_sheet_bindings` keeps only the spreadsheet/tab IDs, schema version, status, and a short provisioning lease—never expense rows or OAuth tokens. Expense agent/skill audit records use constant or minimal redacted payloads and are not used for reporting or calculation. Concurrent first requests coordinate through that lease so Shiva does not intentionally create duplicate ledgers, while the runtime classifier ensures any request that would acquire and use that provisioning lease is evaluated as a write.

Web research uses Brave Search to discover sources and a restricted text fetcher to inspect selected public HTTP(S) pages. It rejects local/private destinations, revalidates redirects, accepts only HTML/plain-text content, and enforces the configured timeout and response-size ceiling. Evidence passed to the planner is capped at 6,000 characters per source and 16,000 characters in total. All page text, snippets, and tool-result content is untrusted data: it cannot authorize an action, change execution mode, disable lockdown, widen the already-frozen pack scope, trigger a write, or establish a new objective. It is not a JavaScript browser and cannot access authenticated pages.

Shiva does not maintain granular permission strings. Each registered skill declares runtime-owned `read|write` mutability and `normal|sensitive` impact. In `SAFE`, reads execute and writes require confirmation. In `AUTO`, ordinary actions explicitly requested by the user, or necessary ordinary steps within that request, execute without repetitive prompts. In `FULL_ACCESS`, clearly requested ordinary actions execute immediately when the connected provider permits them. Sensitive actions require confirmation in every mode, and lockdown blocks ordinary writes while preserving read/diagnostic access.

Confirmations are conversational but persist in PostgreSQL. They are bound to one user, conversation, skill, validated action hash, settings revision, classification, and expiry; changed arguments, changed execution state, increased action risk, an expired request, or a prior approval for a different action cannot authorize execution. `PENDING` approval moves through an atomic `APPROVED` → `EXECUTING` claim and finishes as `EXECUTED` or `FAILED`, so concurrent approvals and retries cannot execute it twice. The runtime—not Gemma—owns classification, approval state, mode changes, lockdown, and tool execution status. The planner returns only a grounded response message, allowing a successfully executed search with zero matches to be reported as “not found” without conflicting status labels.

Skill discovery freezes capability packs rather than the first individual tool list. After opening the Google pack, for example, Shiva can naturally chain `sheets_find` → `sheets_read` → `sheets_update`: it finds the file, asks `sheets_read` for the workbook's exact tab names when necessary, reads the selected tab's live header/current structure, then aligns and appends the new row without guessing `Sheet1`. A direct first call with validated skills from several packs freezes the union of those packs. Gemma's common matching `type: <skill name>` discriminator slip is normalized locally before strict validation. Once any pack has been opened, the turn is an execution run: invalid planner output after its one retry—or reaching the overall 12-decision ceiling without executing a tool—returns a deterministic “no action was executed” result and never hands the write request to ungrounded normal chat. On corrective follow-ups, the latest user message is the sole current task and older conversation is reference-only, so corrected names and values take precedence immediately.

Agent and skill execution metadata is written to `agent_runs` and `skill_runs`; execution audits include effective mode, action classification, confirmation linkage, outcome, sanitized error code, and timing. Inputs and results are bounded and recursively redact credential-shaped fields, labeled secrets, credential-bearing URLs, private keys, JWTs, and common provider-token formats, while expense payloads remain fully redacted. Confirmation reasons and stored arguments are sanitized too. `action_confirmations` stores sanitized arguments plus the exact-action hash, settings revision, and approval lifecycle. These tables are an audit/control plane, not an expense ledger; live credentials belong only in runtime providers and the workspace boundary denies conventional secret-bearing files before model inspection.

### Voice

Open the lightweight browser UI after starting Shiva:

```text
http://127.0.0.1:3000/voice
```

The UI supports hold-to-talk, a conversation transcript, streamed response text, continuous Web Audio playback, stop speaking, typed fallback, reconnect state, new conversation, and automatic reuse of the existing conversation ID over one persistent WebSocket. The backend owns ASR, Gemma streaming, speech chunking, and serial Qwen TTS; the browser only captures mic audio, renders text, and plays binary speech frames.

Gateway endpoints:

- `WS /voice/chat` is the realtime voice session (JSON control both ways; binary mic and speech audio).
- `POST /voice/transcribe` and `POST /voice/synthesize` remain for diagnostics/benchmarks only; the live UI does not call them.
- `POST /voice/chat` remains a diagnostic text stream with voice response style and the same `x-shiva-conversation-id` contract as `/chat`.

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

Voice turns additionally emit `[SHIVA VOICE PERF]` with audio upload, ASR, voice-chat TTFT, first TTS request, TTS, and time-to-first-audio measurements. Every synthesized phrase emits `[SHIVA VOICE TTS PERF]` with text length, queue/synthesis/websocket/receive/playback timestamps, synthesis duration, generated audio duration, real-time factor (`RTF = synthesis duration / audio duration`), decode duration, and underrun ms. Browser console warnings identify playback underruns over 50 ms.

For voice turns, deferred automatic memory extraction waits until the browser reports playback idle over the voice WebSocket, with a 120-second fail-safe. Explicit `remember...` persistence remains synchronous and is never deferred behind playback.

## Current RunPod direct runtime

The current RunPod Pod does not run Docker Compose. Provision PostgreSQL with pgvector, Ollama, Gemma/embedding models, the two Python environments, Qwen voice models, ffmpeg, and `/workspace/shiva/repo/.env` separately. If expense skills are enabled, prefer the three user OAuth values described above so Shiva can create and manage the sheet itself; use a protected service-account JSON and manually shared `EXPENSE_SHEET_ID` only for the legacy path. Configure the Brave key separately for web research. Do not overwrite the production `.env` or credentials during pulls.

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

Do not treat local mocked tests as RunPod integration proof. Real chat requires PostgreSQL/pgvector, the migration, Ollama, Gemma, and embeddinggemma. Real voice additionally requires ffmpeg, both Python services, their Qwen weights, and suitable GPU capacity. Real expense and web runs additionally require working Google credentials/sheet sharing and Brave credentials respectively.

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
| `npm test` | Run mocked chat, memory, voice, agent, execution-policy, confirmation, expense-sheet, and web-tool tests |
| `npm run typecheck` | Strict-check app and tests without emitting |
| `npm run build` | Compile ESM output into `app/dist` |
| `npm run db:generate` | Generate a migration from the Drizzle schema |
| `npm run db:check` | Validate Drizzle migration metadata |
| `npm run db:migrate:dev` | Apply migrations from TypeScript |
| `npm run db:migrate` | Apply migrations from compiled output |
| `npm start` | Run the compiled API |
