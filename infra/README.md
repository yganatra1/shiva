# Shiva infrastructure

V0.3 provides a reproducible future deployment made of the Shiva API, PostgreSQL with pgvector, and internal ASR/TTS services. Ollama remains external and is selected through `OLLAMA_URL`, because the GPU runtime may be on the host or another machine.

## Docker Compose (future Ubuntu/NVIDIA host)

From the repository root:

```bash
cp .env.example .env
export POSTGRES_PASSWORD='replace-with-a-strong-password'
docker compose -f infra/docker/docker-compose.yml config
docker compose -f infra/docker/docker-compose.yml up --build
```

PostgreSQL data is held in the Docker-managed `shiva-postgres-data` volume, and model caches use `shiva-voice-models`; neither lives in the Git checkout. The API image applies committed Drizzle migrations before starting. `OLLAMA_URL` defaults to the host bridge; set it explicitly when inference lives elsewhere.

Compose overrides the voice services to bind `0.0.0.0` only inside the private Compose network. Ports 8101 and 8102 use `expose`, not host `ports`, so browsers can reach voice only through the Fastify gateway. The host defaults remain `127.0.0.1` for direct deployments.

This Compose setup is not the execution mechanism for the current RunPod Pod. RunPod continues to run Node, PostgreSQL/pgvector, Ollama, ASR, and TTS directly; see the root README.
