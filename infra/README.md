# Shiva infrastructure

V0.x provides a reproducible future deployment made of the Shiva API, PostgreSQL with pgvector, and internal ASR/TTS/face services. Ollama remains external and is selected through `OLLAMA_URL`, because the GPU runtime may be on the host or another machine.

## Docker Compose (future Ubuntu/NVIDIA host)

From the repository root:

```bash
cp .env.example .env
export POSTGRES_PASSWORD='replace-with-a-strong-password'
docker compose -f infra/docker/docker-compose.yml config
docker compose -f infra/docker/docker-compose.yml up --build
```

PostgreSQL data is held in the Docker-managed `shiva-postgres-data` volume. Voice caches use `shiva-voice-models` and InsightFace uses `shiva-face-models`; none lives in the Git checkout. The API image applies committed Drizzle migrations before starting. `OLLAMA_URL` defaults to the host bridge; set it explicitly when inference lives elsewhere.

Compose overrides the model services to bind `0.0.0.0` only inside the private Compose network. Ports 8101, 8102, and 8103 use `expose`, not host `ports`, so browsers can reach them only through the Fastify gateway. The host defaults remain `127.0.0.1` for direct deployments. The face process is stateless and has no PostgreSQL credentials; Node owns people records, templates, thresholds, enrollment consistency, and all public identity routes.

The face image and Compose service are CPU-only by default and do not reserve a
GPU. `FACE_PROVIDER=cpu` remains authoritative even if the host exposes CUDA,
so the GPU stays available to Ollama, ASR, and TTS.

This Compose setup is not the execution mechanism for the current RunPod Pod. RunPod continues to run Node, PostgreSQL/pgvector, Ollama, ASR, TTS, and face analysis directly; see the root README.
