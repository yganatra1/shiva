# Shiva V0.1

Shiva is Yash's private personal AI. V0.1 is the portable backend foundation: a Fastify API that gives Shiva an initial identity and delegates local inference to Ollama through a provider-neutral interface.

This milestone intentionally does not implement persistent memory, tools, internet access, authentication, voice, a frontend, or cloud-model fallback.

## Architecture

```text
Client
  -> Fastify API (/health, /chat)
  -> ShivaChatService (system prompt + user message)
  -> AIProvider
  -> OllamaProvider
  -> Ollama POST /api/chat
  -> configured Gemma model
```

The API never calls Ollama directly. That boundary allows later providers to be added without rewriting the chat layer. Zod validates runtime configuration, client input, and Ollama's response shape. A centralized handler converts internal failures into safe API errors.

## Requirements

- Node.js 24
- npm
- Ollama reachable at `OLLAMA_URL` for chat requests
- the configured model installed in Ollama (the default is `gemma4:26b-a4b-it-q4_K_M`)

## Environment setup

From the repository root:

```bash
cp .env.example .env
```

Review the values in `.env` before starting the app:

```text
PORT=3000
HOST=127.0.0.1
OLLAMA_URL=http://127.0.0.1:11434
SHIVA_MODEL=gemma4:26b-a4b-it-q4_K_M
SHIVA_CONTEXT_LENGTH=16384
SHIVA_KEEP_ALIVE=30m
OLLAMA_REQUEST_TIMEOUT_MS=300000
NODE_ENV=development
```

The app resolves this root `.env` file whether it is started from the repository root or from `app/`. Real `.env` files are ignored by Git. Production configuration must be provisioned separately and must not contain committed secrets.

## Local development

```bash
cd /path/to/shiva
cp .env.example .env

cd app
npm install
npm run dev
```

Useful commands from `app/`:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run with hot reload through `tsx` |
| `npm run typecheck` | Check strict TypeScript without emitting files |
| `npm run build` | Compile ESM JavaScript into `app/dist` |
| `npm start` | Run the compiled server |

### Development without local Ollama

Ollama is not required to install dependencies, run the strict typecheck, build the app, or use `/health`. If Ollama is not running on the development machine, `/chat` returns the sanitized `MODEL_UNAVAILABLE` response shown below. Real Gemma inference should be verified on RunPod, where Ollama and the model are installed.

## API checks

Health is intentionally fast and does not contact Ollama:

```bash
curl http://127.0.0.1:3000/health
```

With the default environment values, the response shape is:

```json
{
  "status": "ok",
  "name": "Shiva",
  "version": "0.1.0",
  "model": "gemma4:26b-a4b-it-q4_K_M"
}
```

Chat requires Ollama and the configured model to be available:

```bash
curl -X POST http://127.0.0.1:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Who are you and what is your purpose?"}'
```

Successful response shape:

```json
{
  "response": "..."
}
```

`message` must be a string with at least one non-whitespace character and no more than 20,000 characters. Unknown request fields are rejected.

Internal provider details, stack traces, environment values, and Ollama response bodies are never returned to clients. For example, an unreachable Ollama instance produces a safe error:

```json
{
  "error": {
    "code": "MODEL_UNAVAILABLE",
    "message": "Shiva's local model is currently unavailable."
  }
}
```

## RunPod deployment

Application code is portable and does not depend on a RunPod-specific path. With the repository cloned at `/workspace/shiva/repo`, deploy with:

Before starting, provision `/workspace/shiva/repo/.env` out of band using the keys in `.env.example`, set `NODE_ENV=production`, and do not overwrite an existing production file.

```bash
cd /workspace/shiva/repo
git pull --ff-only

cd app
npm install
npm run typecheck
npm run build
npm start
```

Run the health and chat `curl` commands from another shell. `npm start` runs in the foreground in V0.1; production process supervision is a later operational decision.

Runtime data stays outside Git, for example:

```text
/workspace/shiva/
├── repo/
├── data/
├── models/
├── ollama/
├── logs/
├── backups/
└── config/
```

Do not overwrite the separately provisioned production `.env` during deployment.

## Project layout

```text
shiva/
├── app/
│   ├── src/
│   │   ├── api/
│   │   │   ├── api-error.ts
│   │   │   ├── chat-route.ts
│   │   │   ├── error-handler.ts
│   │   │   └── health-route.ts
│   │   ├── brain/
│   │   │   ├── ai-provider.ts
│   │   │   ├── ollama-provider.ts
│   │   │   └── system-prompt.ts
│   │   ├── config/
│   │   │   └── environment.ts
│   │   ├── memory/
│   │   │   └── README.md
│   │   ├── security/
│   │   │   └── README.md
│   │   ├── services/
│   │   │   └── chat-service.ts
│   │   ├── tools/
│   │   │   └── README.md
│   │   ├── types/
│   │   │   └── README.md
│   │   ├── app.ts
│   │   └── server.ts
│   ├── package-lock.json
│   ├── package.json
│   └── tsconfig.json
├── config/
│   └── README.md
├── docs/
│   └── initial.md
├── scripts/
│   └── README.md
├── .env.example
├── .gitignore
└── README.md
```
