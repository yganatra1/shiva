# Shiva device architecture

The Android companion app's live connection, command correlation, and timeouts live in `agents/device-service` — a process separate from `shiva-api`. `shiva-api` never holds the phone's WebSocket and does not know how to correlate `device_command`/`device_command_result` frames; it only asks device-service to run one `device.*` command and waits for the real answer.

```text
Android app
  └─ one WebSocket, same origin/path it always used: /device/ws
       │
       ▼
shiva-api  (relay only — no dispatcher, no correlation)
       │  relays every frame byte-for-byte, both directions
       ▼
shiva-device-service :3002 (internal only)
       ├── DeviceCommandDispatcher — owns the live socket, correlates
       │   command IDs, applies per-command timeouts
       ├── GET  /device/ws   — the phone's real connection (DEVICE_WS_TOKEN gated)
       ├── POST /v1/dispatch — shiva-api asks for one device.* command
       └── GET  /v1/status   — is a phone connected right now

device_call / device_contacts_search / device_camera_capture / ... (skills)
       │  each skill just calls dispatcher.dispatch(type, args)
       ▼
shiva-api's DeviceServiceClient
       │  POST /v1/dispatch { type, arguments, timeoutMs } over loopback/Compose network
       ▼
shiva-device-service → phone → phone's reply → HTTP response → skill result
```

## Why the split

- **Ownership.** The live phone connection, command correlation, timeouts, and reconnect handling live in one place instead of being spread across `shiva-api` route handlers.
- **Blast radius.** A bug in device command handling can't take down chat/voice/memory, and restarting device-service doesn't drop an in-flight chat request.
- **Zero change for the phone.** The Android app still connects to the same `shiva-api` origin and `/device/ws` path it always has — no APK rebuild is required to adopt this split. `shiva-api`'s relay (`app/src/api/device-socket-relay-route.ts`) forwards the connection straight through to device-service, including the `?token=` query param, and closes the phone's socket if device-service is unreachable.

## Request routing, end to end

1. **Chat/voice/memory turns** (`POST /chat`, `WS /voice/chat`, `/people`, etc.) are handled entirely inside `shiva-api` — they never touch device-service.
2. **The Android app's connection**: phone → `wss://<shiva-api host>/device/ws?token=...` → `shiva-api` relay → `ws://device-service:3002/device/ws?token=...`. Device-service validates `DEVICE_WS_TOKEN` and calls `DeviceCommandDispatcher.connect()`. `shiva-api` never sees the token or the command traffic — it only pipes bytes.
3. **A device skill runs** (e.g. `device_call`, `device_camera_capture`, run through the agent loop like any other skill): the skill calls `DeviceServiceClient.dispatch(type, arguments, { timeoutMs, signal })`, which does `POST http://device-service:3002/v1/dispatch` and awaits the response.
4. **Device-service** validates the body, calls its own `DeviceCommandDispatcher.dispatch()`, sends a `device_command` frame down the phone's live socket, and waits (clamped 1s–120s) for the matching `device_command_result`.
5. **The phone replies**; device-service resolves the pending command and answers `shiva-api`'s HTTP request with `{ commandId, status, result?, error? }` (200), or a `4xx`/`5xx` with `{ error: { code, message } }` when the phone never answered — `503` not connected, `504` timed out, `409` disconnected mid-flight, `499` cancelled, `502` anything else. `DeviceServiceClient` turns that back into the same `DeviceDispatchError` codes skills already handled before this split.
6. **Cancellation propagates**: if the skill's `AbortSignal` fires (e.g. the agent run is interrupted), `DeviceServiceClient` aborts its `fetch`, which closes the HTTP request to device-service, which aborts device-service's own wait on the phone — nothing is left dangling on either hop.

## Environment

| Variable | Read by | Purpose |
| --- | --- | --- |
| `DEVICE_SERVICE_URL` | `shiva-api` | Where to reach device-service (`http://device-service:3002` in Compose, `http://127.0.0.1:3002` for direct runs). |
| `DEVICE_SERVICE_HOST` / `DEVICE_SERVICE_PORT` | `shiva-device-service` | Where device-service itself binds. |
| `DEVICE_WS_TOKEN` | `shiva-device-service` | If set, `/device/ws` requires a matching `?token=`. Unset means no auth is enforced — set it for any deployment reachable off localhost. |

`/v1/dispatch`, `/v1/status`, and `/health` are internal-only: there's no separate credential for them, matching how `shiva-api` already reaches the ASR/TTS/face services over an unauthenticated internal URL.

## Deliberate limits

Device-service dispatches whatever `device.*` command a skill asks for; it does not itself know what Zepto, GPay, WhatsApp, or any other app looks like. Higher-level shopping/payment/messaging automation (see `PLANNED_DEVICE_COMMAND_TYPES` in `agents/device-service/src/device-protocol.ts`) is a future Android-side capability plus a new skill — this split only establishes where that automation would plug in, it does not implement it. UPI PIN entry and other biometric/payment authentication stay on-device and are never something Shiva types or stores.
