# Shiva V0.2

Shiva is Yash's private personal AI. V0.2 keeps the Fastify/Ollama streaming foundation and adds persistent working, episodic, and semantic memory with PostgreSQL, pgvector, embeddinggemma, and Drizzle.

## Architecture

```text
Client -> Fastify POST /chat
       -> conversation + bounded working history
       -> embeddinggemma -> semantic/episodic retrieval -> ranking
       -> ShivaChatService -> AIProvider -> Ollama/Gemma stream
       -> assistant message -> synchronous explicit / deferred automatic extraction
       -> Drizzle repository -> PostgreSQL + pgvector
```

The API does not call Ollama or PostgreSQL directly. Provider and repository interfaces keep model, embedding, and persistence details out of the route layer. See [docs/memory-architecture.md](docs/memory-architecture.md).

V0.2 does not add tools, browser/internet access, voice, authentication, a frontend, cloud fallback, procedural memory, or a knowledge graph.

## Requirements

- Node.js 24 and npm
- PostgreSQL with the pgvector extension available
- Ollama reachable at `OLLAMA_URL`
- the configured Gemma model and `embeddinggemma` installed for real `/chat` requests

Health, typechecking, building, and mocked tests do not require Ollama or PostgreSQL.

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
SHIVA_PERF_LOG=false
NODE_ENV=development
```

`SHIVA_USER_ID` identifies the single V0.2 owner and must remain stable across restarts. Use a strong database password in real environments. The app deliberately resolves the root `.env` whether commands run from the root or `app/`.

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

If a local PostgreSQL/pgvector database is available and `DATABASE_URL` is configured:

```bash
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
{"status":"ok","name":"Shiva","version":"0.2.0","model":"gemma4:26b-a4b-it-q4_K_M"}
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

### Optional performance tracing

Set `SHIVA_PERF_LOG=true` and restart Shiva to emit one `[SHIVA PERF]` structured log for each `/chat` request. It reports the database, working-memory, embedding, pgvector retrieval, ranking, prompt construction, Ollama TTFT/generation, persistence, and total timings in milliseconds. `pre-ollama` and `total-ttft` are elapsed from request entry; the other foreground stages are durations.

Deferred automatic memory work emits a separate `[SHIVA PERF ASYNC]` record with its queue delay and extraction duration. It is intentionally absent from `total-request`. Explicit `remember...` processing remains synchronous and appears as `explicit-memory` in the foreground record.

Disable tracing again with `SHIVA_PERF_LOG=false`; it is off by default.

## Current RunPod direct runtime

The current RunPod Pod does not run Docker Compose. Provision PostgreSQL with pgvector, Ollama, the models, and `/workspace/shiva/repo/.env` separately. Do not overwrite the production `.env` during pulls.

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

Before `/chat` verification, ensure the two configured models exist:

```bash
ollama pull embeddinggemma
ollama list
```

Then, from another shell, run the health and chat curls above. `npm start` is foreground execution; process supervision remains an operational choice. Keep runtime data outside Git, for example under `/workspace/shiva/{data,models,ollama,logs,backups,config}`.

Do not treat local mocked tests as RunPod integration proof. Real `/chat` succeeds only when PostgreSQL/pgvector, the migration, Ollama, Gemma, and embeddinggemma are available together.

## Future Docker runtime

The future Ubuntu/NVIDIA-server path is:

```text
Git -> Ubuntu NVIDIA server -> Docker Compose
```

The Compose definition runs the API and a pgvector-enabled PostgreSQL database while leaving Ollama externally configurable. See [infra/README.md](infra/README.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Hot-reload the API from TypeScript |
| `npm test` | Run mocked memory, stream, cancellation, and provider tests |
| `npm run typecheck` | Strict-check app and tests without emitting |
| `npm run build` | Compile ESM output into `app/dist` |
| `npm run db:generate` | Generate a migration from the Drizzle schema |
| `npm run db:check` | Validate Drizzle migration metadata |
| `npm run db:migrate:dev` | Apply migrations from TypeScript |
| `npm run db:migrate` | Apply migrations from compiled output |
| `npm start` | Run the compiled API |
