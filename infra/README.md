# Shiva infrastructure

V0.x provides a reproducible deployment made of Shiva Core, PostgreSQL with pgvector, persistent Redis Streams, internal ASR/TTS/face services, and independently managed device/Google agents. Ollama remains external and is selected through `OLLAMA_URL`, because the GPU runtime may be on the host or another machine.

## Docker Compose (future Ubuntu/NVIDIA host)

From the repository root:

```bash
cp .env.example .env
export POSTGRES_PASSWORD='replace-with-a-strong-password'
docker compose -f infra/docker/docker-compose.yml config
docker compose -f infra/docker/docker-compose.yml up --build
```

PostgreSQL data is held in `shiva-postgres-data`. Redis runs with AOF (`appendfsync everysec`) in `shiva-redis-data`, so queued tasks/responses survive container restarts. Voice caches use `shiva-voice-models` and InsightFace uses `shiva-face-models`; none lives in the Git checkout. The API image applies committed Drizzle migrations before starting. `OLLAMA_URL` defaults to the host bridge; set it explicitly when inference lives elsewhere.

Compose overrides internal services to bind only inside the private network. Redis is not published, and ports 8101, 8102, 8103, and device-agent 3002 use `expose`, not host `ports`. The Android app still connects to the public Shiva API `/device/ws`; Core relays that device bridge internally, while agent orchestration uses Redis Streams. Device Agent receives only Redis/Ollama/device configuration, not Google/database secrets. Google Agent receives only its Google/Ollama/Redis runtime configuration; Core owns durable orchestration and confirmation state, so the worker has no PostgreSQL connection. The host defaults remain `127.0.0.1` for direct deployments.

Compose supplies each worker's environment explicitly. Production worker entrypoints do not open any dotenv file. Direct local development instead uses the fixed, gitignored `.env.device-agent` and `.env.google-agent` files created from their matching examples; neither worker reads Core's root `.env`.

The face image and Compose service are CPU-only by default and do not reserve a
GPU. `FACE_PROVIDER=cpu` remains authoritative even if the host exposes CUDA,
so the GPU stays available to Ollama, ASR, and TTS.

This Compose setup is not the execution mechanism for the current RunPod Pod. RunPod continues to run Node, PostgreSQL/pgvector, Ollama, ASR, TTS, and face analysis directly; see the root README.
