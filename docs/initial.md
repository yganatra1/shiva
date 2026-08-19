# Build Shiva V0.1 — Personal AI Backend Foundation

You are working on **Shiva**, a private personal AI system.

The project will eventually become a secure, voice-first, memory-enabled personal AI that knows the user deeply, has persistent memory, internet access, tools/actions, speaker verification, vision, and optional fallback to frontier cloud models.

For now, build **only the clean backend foundation for Shiva V0.1**.

## Current Infrastructure

The production/development AI server is a RunPod Ubuntu GPU instance with:

* NVIDIA RTX 3090
* 24 GB VRAM
* ~117 GB system RAM
* 32 vCPU
* Persistent `/workspace`
* Ollama already installed and working
* Main local model already downloaded and tested:

```text
gemma4:26b-a4b-it-q4_K_M
```

Ollama is available at:

```text
http://127.0.0.1:11434
```

The model has already been verified to run:

```text
100% GPU
16K context
```

However, development will happen **locally in VS Code on macOS**, committed to Git, then pulled onto RunPod.

Do not couple application code to RunPod.

The application must remain portable so later we can migrate from RunPod to our own Ubuntu + NVIDIA GPU server without changing application architecture.

---

# Technology

Use:

* Node.js 24
* TypeScript
* Fastify
* Zod
* dotenv
* native Node `fetch`
* ESM modules
* strict TypeScript

Do NOT introduce:

* NestJS
* Express
* ORMs yet
* Redis yet
* PostgreSQL yet
* Docker yet
* unnecessary frameworks
* unnecessary abstractions
* microservices

Keep V0.1 very clean and understandable.

---

# Repository Structure

Create this structure:

```text
shiva/
├── app/
│   ├── src/
│   │   ├── api/
│   │   ├── brain/
│   │   ├── config/
│   │   ├── memory/
│   │   ├── tools/
│   │   ├── security/
│   │   ├── services/
│   │   ├── types/
│   │   └── server.ts
│   │
│   ├── package.json
│   └── tsconfig.json
│
├── docs/
├── scripts/
├── config/
├── .gitignore
├── .env.example
└── README.md
```

The following folders are placeholders for future phases:

```text
memory/
tools/
security/
services/
```

Do not over-engineer them yet.

---

# Environment Configuration

All runtime configuration must come from environment variables.

Support:

```text
PORT=3000
HOST=127.0.0.1
OLLAMA_URL=http://127.0.0.1:11434
SHIVA_MODEL=gemma4:26b-a4b-it-q4_K_M
SHIVA_CONTEXT_LENGTH=16384
SHIVA_KEEP_ALIVE=30m
NODE_ENV=development
```

Create:

```text
.env.example
```

Never commit `.env`.

Validate important environment variables using Zod.

Application startup should fail clearly if required configuration is invalid.

---

# Shiva Identity

Create:

```text
app/src/brain/system-prompt.ts
```

Use a clean initial system prompt based on this intent:

```text
You are Shiva, Yash's private personal AI.

Your purpose is to become a highly capable personal intelligence that understands Yash, remembers relevant information, uses tools, accesses current information when required, and assists him securely.

Core principles:

- Be natural, intelligent and concise.
- Do not pretend to know information you do not know.
- Never invent current or live information.
- If information may have changed, Shiva should eventually use internet/tools rather than model training knowledge.
- Never claim an external action succeeded unless the corresponding tool confirms success.
- Security and privacy are fundamental.
- Never expose credentials, secrets or internal private system information.
- Long-term personal information will eventually come from Shiva's memory system rather than being hardcoded into this system prompt.
```

Do not put personal facts about Yash directly into this prompt other than Shiva being his private AI.

Long-term personal information will later come from the memory layer.

---

# Ollama Provider

Create a proper Ollama provider under:

```text
app/src/brain/
```

Do not scatter Ollama-specific HTTP code throughout the application.

Create a clean abstraction so that later we can support providers such as:

```text
OllamaProvider
OpenAIProvider
OtherLocalProvider
```

without rewriting the chat/application layer.

For now, implement only Ollama.

The provider should call:

```text
POST /api/chat
```

Use:

```json
{
  "model": "configured model",
  "messages": [],
  "think": false,
  "stream": false,
  "keep_alive": "30m"
}
```

For V0.1:

```text
think = false
stream = false
```

We will add dynamic thinking and streaming later.

Handle:

* network failures
* Ollama unavailable
* non-200 responses
* malformed responses
* empty responses
* request timeout

Do not expose raw internal errors to API clients.

Log enough information for debugging without logging secrets.

---

# Model Abstraction

Define a simple model interface conceptually similar to:

```typescript
interface AIProvider {
  chat(input: ChatInput): Promise<ChatResult>;
}
```

Avoid over-engineering.

The important goal is that:

```text
API layer
   ↓
Shiva brain/service
   ↓
AIProvider
   ↓
Ollama
```

rather than:

```text
API → Ollama directly
```

---

# Chat Service

Create a Shiva chat service.

For V0.1 it should:

1. receive the user's message
2. build messages containing:

   * Shiva system prompt
   * user message
3. call the configured AI provider
4. return the response

Later we will insert:

```text
memory retrieval
tool selection
security policies
conversation history
internet access
```

between these steps.

Design the code so those additions will be straightforward.

---

# API Endpoints

Create:

## GET /health

Example response:

```json
{
  "status": "ok",
  "name": "Shiva",
  "version": "0.1.0",
  "model": "gemma4:26b-a4b-it-q4_K_M"
}
```

Optionally include whether Ollama is reachable, but don't make `/health` unnecessarily slow.

---

## POST /chat

Request:

```json
{
  "message": "Who are you?"
}
```

Validate using Zod.

Response:

```json
{
  "response": "..."
}
```

Reject:

* empty messages
* non-string input
* unreasonably large input

Use a reasonable initial message limit such as 20,000 characters.

---

# Error Handling

Create centralized API error handling.

Responses should be clean, for example:

```json
{
  "error": {
    "code": "MODEL_UNAVAILABLE",
    "message": "Shiva's local model is currently unavailable."
  }
}
```

Do not expose:

* stack traces
* server paths
* internal IP information
* environment variables
* raw Ollama errors

Log technical details server-side.

---

# Security Foundations

Do NOT build authentication yet.

But create the architecture with security in mind.

Important future Shiva rule:

```text
The LLM will NEVER be the authority deciding whether a sensitive action is allowed.
```

Future flow:

```text
LLM requests action
       ↓
Shiva Security Engine
       ↓
permissions
identity
device trust
risk
confirmation
       ↓
Tool executes
```

Create the `security/` folder and a short README or placeholder explaining this principle.

Do not implement fake security logic yet.

---

# Memory Foundations

Create the `memory/` folder with documentation explaining that Shiva's future memory will contain:

```text
people
relationships
preferences
projects
events
decisions
routines
procedures
conversation history
important facts
action history
```

Future storage:

```text
PostgreSQL
+
pgvector
```

But DO NOT install or implement PostgreSQL in this task.

The model must remain independent of the memory store.

Important principle:

```text
Model = intelligence
Memory = personal knowledge/history
Tools = capabilities
Security = authority
```

---

# Internet / Tool Foundations

Create the `tools/` folder with a minimal interface/README documenting the future concept.

Shiva will always have controlled internet access.

Eventually the resolution flow should be:

```text
User asks something
       ↓
Can answer safely from memory/general knowledge?
       ↓
If current information is required
       ↓
Dedicated tool available?
   YES → use tool
   NO
       ↓
Internet search/browser fallback
```

Important rule:

```text
If information may have changed and Shiva has no current source,
Shiva must not guess.
```

Do NOT implement internet browsing yet.

---

# Package Scripts

Provide useful scripts such as:

```json
{
  "dev": "...",
  "build": "...",
  "start": "...",
  "typecheck": "..."
}
```

Development should support hot reload using `tsx`.

---

# Git Ignore

Properly ignore:

```text
node_modules
dist
.env
.env.*
logs
.DS_Store
coverage
*.log
```

But keep:

```text
.env.example
```

committed.

Never commit:

* AI models
* PostgreSQL data
* uploads
* secrets
* API credentials
* runtime databases
* generated logs

---

# RunPod Deployment

The Git repository will later be cloned to:

```text
/workspace/shiva/repo
```

Runtime data will remain outside Git, roughly:

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

Therefore application code must not assume that runtime data lives inside the Git repository.

The server will receive its production `.env` separately.

---

# README

Write a useful README covering:

* what Shiva is
* architecture
* local development
* environment setup
* install
* run
* health test
* chat test
* RunPod deployment flow

Example RunPod flow:

```bash
cd /workspace/shiva/repo
git pull

cd app
npm install
npm run build
npm start
```

Do not include secrets.

---

# Test Commands

Document these:

```bash
curl http://127.0.0.1:3000/health
```

and:

```bash
curl -X POST http://127.0.0.1:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Who are you and what is your purpose?"}'
```

---

# Code Quality

Requirements:

* clean TypeScript
* strict typing
* descriptive names
* small functions
* avoid `any`
* no duplicate logic
* no unnecessary patterns
* no giant classes
* no premature abstractions
* readable by a senior Node.js engineer
* production-minded error handling
* comments only when they add useful context

This is an evolving personal system, so maintainability matters more than cleverness.

---

# Important: Do Not Overbuild

For this task, STOP once we have:

```text
Local source repository
       ↓
Fastify API
       ↓
Shiva system identity
       ↓
AI provider abstraction
       ↓
Ollama provider
       ↓
Gemma 4 26B-A4B
       ↓
POST /chat
       ↓
working response
```

Do NOT implement yet:

* PostgreSQL
* pgvector
* Redis
* memory extraction
* embeddings
* internet search
* browser automation
* Gmail
* calendar
* voice
* speaker recognition
* wake word
* TTS
* STT
* authentication
* permissions
* GPT fallback
* frontend/PWA

Those are subsequent milestones.

---

# Execution Instructions

First inspect the existing repository if one exists.

Then:

1. show me the proposed files/changes briefly
2. implement the project
3. run npm install
4. run TypeScript typecheck
5. run build
6. report any errors and fix them
7. do not claim `/chat` works against Gemma unless Ollama is actually available in the environment
8. provide the final directory tree
9. provide exact commands I need to run locally and on RunPod

Do not make destructive system-level changes.

Do not modify anything outside the Shiva repository.

The goal of this milestone is a **clean, minimal, production-minded Shiva V0.1 backend that we can commit to Git and run against our existing Gemma model on the RTX 3090 server.**
