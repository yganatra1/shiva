# Shiva device architecture

The Android companion app's live connection and every phone-facing capability live in the **device agent** — `app/src/agents/device`, a separate process from `shiva-api` (same npm package, own entry point: `node dist/agents/device/device-agent-runner.js`). `shiva-api` never holds the phone's WebSocket, never correlates `device_command`/`device_command_result` frames, and never registers or executes individual phone skills.

```text
Android app
  └─ one WebSocket, same origin/path it always used: /device/ws
       │
       ▼
shiva-api  (relay only — no dispatcher, no correlation, no AI)
       │  relays every frame byte-for-byte, both directions
       ▼
device agent :3002 (internal only, own process, no database)
       ├── DeviceCommandDispatcher — owns the live socket, correlates
       │   command IDs, applies per-command timeouts
       ├── GET  /device/ws   — the phone's real connection (DEVICE_WS_TOKEN gated)
       ├── GET  /health
       ├── Redis task worker  — run a minimal self-contained instruction: its own
           small planner (its own Ollama call) decides which of the 17 device.*
           tools to call, in what order, until done or it gives up

One path handles every phone request:

delegate_to_agent("device-agent", minimal instruction + Core executionContext)
       │  AgentClient.delegate("device", goal)
       ▼
Redis task → device agent's loop runs to completion → plain response message → Shiva Core
```

## Why a separate process

- **Ownership.** The live phone connection, command correlation, and timeouts live in one place instead of being spread across `shiva-api` route handlers.
- **Blast radius.** A bug in device command handling can't take down chat/voice/memory, and restarting the device agent doesn't drop an in-flight chat request.
- **Zero change for the phone.** The Android app still connects to the same `shiva-api` origin and `/device/ws` path it always has — no APK rebuild needed. `shiva-api`'s relay (`app/src/api/device-socket-relay-route.ts`) forwards the connection straight through, including the `?token=` query param, and drops the phone's socket if the device agent is unreachable.
- **Isolated intelligence.** The device agent's own tool-calling loop (its own Ollama calls, its own small planner) runs entirely inside that process. A slow or stuck phone goal never blocks `shiva-api`'s chat planner, and vice versa.

## Complete delegation

The main runtime registers no `device_*` skills and does not use `DeviceServiceClient`. The only main-agent surface is `delegate_to_agent` in the `agents` pack. Its device entry explicitly owns all Android work, so even a single contact search, notification read, phone call, or camera request is handed off as a complete goal.

`shiva-api` persists the original request and natural-language `executionContext`, then publishes a minimal instruction to `shiva:agent:tasks`. The independently managed device process consumes only entries addressed to `device-agent`. Its bounded loop (`app/src/agents/device/device-agent-loop.ts`, default 15 steps, `DEVICE_AGENT_MAX_STEPS`) chooses among the `device.*` tools, dispatches locally, and publishes one plain-text report to `shiva:agent:responses`. Core reloads its saved context and decides the next action. The legacy `/v1/delegate` endpoint remains temporarily for compatibility but is not used by production Core orchestration.

The older `/v1/dispatch`, `DeviceServiceClient`, and five high-level skill adapters remain as internal compatibility/test components, but `createAgentRuntime` deliberately does not register or call them. They are not part of the production chat flow.

This is deliberately the **generic foundation for multiple agents**, not device-specific plumbing: `AgentRegistry`, the PostgreSQL outbox, Redis transport, and `delegate_to_agent` know nothing about phones. A future agent is a new human-readable registry entry and independent worker process; Core transport code does not change.

## The device agent's tool catalog

All 17 real Android handlers (`app/src/agents/device/device-tools.ts`, kept in sync with `IMPLEMENTED_DEVICE_COMMAND_TYPES` in `device-protocol.ts`):

- The 5 original: `device.contacts.search`, `device.phone.call`, `device.notifications.list`, `device.notifications.read`, `device.camera.capture`.
- 12 generic UI-automation primitives, backed by a real `AccessibilityService` on the Android side (`AccessibilityUiEngine.kt`): `device.app.open`, `device.app.list`, `device.ui.inspect`, `device.ui.find`, `device.ui.click`, `device.ui.type`, `device.ui.scroll`, `device.ui.wait`, `device.ui.screenshot`, `device.ui.gesture`, `device.ui.back`, `device.ui.global`.

Arguments stay a flat `Record<string,string>` end to end — the device agent's loop does no per-tool schema validation; the phone is the real validator, and a malformed call just comes back `FAILED`/`UNSUPPORTED`/`DENIED` for the planner to react to, the same way a person would adjust after a bad tap.

Camera captures and UI screenshots are passed to the device agent's next Ollama planner call through the provider's image field. Their base64 bytes are replaced with bounded metadata in the textual step history and trace logs, and never appear in the delegated result returned to the main agent. This provides visual reasoning inside the delegated flow; enrolled-person matching remains on the main `/chat` image path rather than being used as device authorization.

## Request routing, end to end

1. **Chat/voice/memory turns** (`POST /chat`, `WS /voice/chat`, `/people`, etc.) are handled entirely inside `shiva-api` — they never touch the device agent.
2. **The Android app's connection**: phone → `wss://<shiva-api host>/device/ws?token=...` → `shiva-api` relay → `ws://device-agent:3002/device/ws?token=...`. The device agent validates `DEVICE_WS_TOKEN` and calls `DeviceCommandDispatcher.connect()`. `shiva-api` never sees the token or the command traffic — it only pipes bytes.
3. **The main planner delegates every phone goal**: resolve required Core context → `delegate_to_agent("device-agent", instruction)` → PostgreSQL outbox → Redis Stream. There is no competing direct-device pack in the main planner catalog.
4. **The device agent executes it**: it fails fast with `503` if no phone is connected; otherwise its planner selects and runs one `device.*` command at a time against its in-process dispatcher, observes the results, and returns `{ success, summary, steps }` when complete or step-limited.
5. **The main planner reports grounded evidence**: `success: false` becomes `AGENT_GOAL_FAILED` with the device agent's explanation; success returns its factual summary and step count.
6. **Durable work outlives client disconnects**: cancellation applies until Core commits the task. Once it is in PostgreSQL, the task is recovered/published independently. Worker shutdown cancels its active planner/phone command; an unacknowledged entry is reclaimed after restart with bounded attempts.

## Environment

| Variable | Read by | Purpose |
| --- | --- | --- |
| `DEVICE_AGENT_URL` | `shiva-api` | Where to reach the device agent (`http://device-agent:3002` in Compose, `http://127.0.0.1:3002` for direct/PM2 runs). |
| `DEVICE_AGENT_HOST` / `DEVICE_AGENT_PORT` | device agent | Where the device agent itself binds. |
| `DEVICE_AGENT_MAX_STEPS` | device agent | Bounds one delegated goal's tool-calling loop (default 15). |
| `DEVICE_WS_TOKEN` | device agent | If set, `/device/ws` requires a matching `?token=`. Unset means no auth is enforced — set it for any deployment reachable off localhost. |
| `DEVICE_AGENT_MOCK_CALL_OUTCOME` | device agent | Explicit POC-only phone-call simulation (`answered` or `not_answered`). Unset by default, so production never fabricates call state and requires the real device bridge. |

The device agent reuses `OLLAMA_URL`/`SHIVA_MODEL` for its own planner — no separate model config in v1. `/v1/delegate`, the compatibility `/v1/dispatch`, and `/health` are internal-only: no separate credential, matching how `shiva-api` already reaches ASR/TTS/face over an unauthenticated internal URL.

For local development, copy `.env.device-agent.example` to the gitignored `.env.device-agent`; `npm run agent:device` and `npm run dev:device-agent` explicitly opt into that fixed file, and the worker never reads Core's `.env`. Compiled/production startup does not opt into dotenv at all and relies on the PM2-filtered or Compose-explicit environment.

For the documented conditional-call POC without an Android bridge, start the device process with `DEVICE_AGENT_MOCK_CALL_OUTCOME=not_answered`. A delegated instruction such as `Call Mom at +91… and report whether she answered` returns the plain-text response `Mom did not answer the call.` with `mock: true` transport metadata. This mode accepts only call instructions and places no real call; remove the variable to restore the production bridge path.

## Deliberate v1 limits

- No confirmation/execution-mode gating *inside* the device agent's own tool-calling loop — only the outer `delegate_to_agent` skill call is gated (`mutability: write, impact: sensitive`), which is where `shiva-api`'s existing `ExecutionPolicyEngine` applies.
- No per-tool argument schema in the loop — Android remains the source of truth on argument correctness.
- Zepto/GPay/WhatsApp/any specific app automation is not hardcoded anywhere. The loop is fully generic over the 17 primitives; whether a real goal like ordering groceries actually completes depends on the model's own UI reasoning, not on anything in this codebase. UPI PIN entry and other biometric/payment authentication stay on-device and are never something Shiva types or stores.
- Only one agent (`device`) is registered today. `PLANNED_DEVICE_COMMAND_TYPES` in `device-protocol.ts` still tracks Android capabilities that exist in the manifest but have no handler yet (SMS, location, microphone, WhatsApp) — none of these are dispatched.
