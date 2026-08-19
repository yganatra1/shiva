# Shiva infrastructure

V0.2 provides a reproducible future deployment made of the Shiva API and PostgreSQL with pgvector. Ollama remains external and is selected through `OLLAMA_URL`, because the GPU runtime may be on the host or another machine.

## Docker Compose (future Ubuntu/NVIDIA host)

From the repository root:

```bash
cp .env.example .env
export POSTGRES_PASSWORD='replace-with-a-strong-password'
docker compose -f infra/docker/docker-compose.yml config
docker compose -f infra/docker/docker-compose.yml up --build
```

PostgreSQL data is held in the Docker-managed `shiva-postgres-data` volume, not in the Git checkout. The API image applies committed Drizzle migrations before starting. `OLLAMA_URL` defaults to the host bridge; set it explicitly when inference lives elsewhere.

This Compose setup is not the execution mechanism for the current RunPod Pod. RunPod continues to run Node, PostgreSQL/pgvector, and Ollama directly; see the root README.
