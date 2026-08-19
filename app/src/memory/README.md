# Memory foundation

Shiva's future memory layer will hold personal knowledge and history such as:

- people and relationships
- preferences, projects, events, and decisions
- routines and procedures
- conversation history and important facts
- action history

The planned storage layer is PostgreSQL with pgvector. It is intentionally not installed or implemented in V0.1, and model-provider code must remain independent of the memory store.

The architectural boundary is:

```text
Model    = intelligence
Memory   = personal knowledge and history
Tools    = capabilities
Security = authority
```
