# Security foundation

The language model will never be the authority that decides whether a sensitive action is allowed.

A future action request will pass through a deterministic Shiva security engine before any tool runs:

```text
LLM requests action
        |
        v
permissions -> identity -> device trust -> risk -> confirmation
        |
        v
tool executes
```

Authentication, authorization, permissions, and device trust are deliberately not implemented in V0.1. Until they exist, the server binds to `127.0.0.1` by default.
