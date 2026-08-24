# Shiva agent and skill architecture

## Purpose

Shiva now has two distinct agent layers:

- **Shiva Core** is the only user-facing brain. It owns intent, memory and people resolution, security checks, context minimization, delegation, continuation reasoning, and final communication.
- **Specialized agents** are independently managed processes. They receive one minimal natural-language instruction, use only their domain tools, and return one plain natural-language message. They never receive or take over the user conversation.

The current process registry contains `device-agent` and `google-agent`. Its IDs are stable routing identifiers; names, descriptions, and capabilities are free-form human-readable text, so adding a future agent does not expand a central capability enum.

## Durable multi-agent flow

```text
Client -- HTTP /chat or Core WebSocket --> Shiva Core
                                            |
                     memory + people + policy checks
                                            |
                     generate short executionContext prose
                                            |
             PostgreSQL request/task outbox (durable intent)
                                            |
                         shiva:agent:tasks (Redis Stream)
                                            |
                              specialized agent process
                                            |
                      shiva:agent:responses (plain message)
                                            |
                                   Shiva Core reloads:
                              original user request
                            + saved executionContext
                            + latest agent response
                                            |
                       next delegation or final Core message
                                            |
                       PostgreSQL + WS /chat/updates -> Client
```

`executionContext` is immutable prose such as “I need to resolve Mom, ask Device Agent to call her, and if she does not answer ask Google Agent to add ₹500 to the expense sheet.” It is deliberately not a workflow definition. There are no persisted step arrays, next-step fields, semantic response enums, or workflow-status enums. Core starts a fresh model reasoning pass for every agent reply.

The Redis envelopes contain only technical routing/correlation fields. An agent instruction carries its semantic context as ordinary text; the response's important field is `message: string`. PostgreSQL stores `orchestration_requests`, `agent_tasks`, and `agent_responses` for recovery and audit. Delivery timestamps, deadlines, attempts, stream IDs, and abandonment markers are transport reliability data, not business workflow state.

Both logical queues use shared streams:

```text
shiva:agent:tasks
shiva:agent:responses
```

Because Redis Streams cannot filter consumer-group reads by `agentId`, each agent ID has its own group on the shared task stream. A group acknowledges foreign entries only in its own group; replicas of the same agent share the intended group. Core uses one response group. Workers acknowledge a task only after publishing its response, recover stale pending entries with `XAUTOCLAIM`, cap delivery attempts, maintain short-lived heartbeats, and shut down gracefully. PostgreSQL is an outbox for tasks that were committed before Redis publication. Core converts expired tasks into a grounded timeout response instead of waiting forever.

Task and response publication is idempotent by `taskId`, and an active worker
renews its pending-entry lease so a slow handler is not concurrently reclaimed.
This closes the Redis `XADD`/`XACK` and Core outbox publication crash windows.
Like any at-least-once queue, it cannot by itself prove exactly-once execution
inside an external phone or Google API if a process dies after the provider
commits a side effect but before the worker publishes its response. New
side-effect adapters should pass the durable task ID through as a provider
idempotency key whenever that provider supports one.

The shared streams and publication-deduplication keys are deliberately not
trimmed by a naive `MAXLEN`: doing so could erase work that an offline
agent-specific consumer group has not seen. Operators should monitor Redis AOF
growth; safe compaction must use the acknowledged/pending floor across every
group and retain response deduplication until the correlated task is durably
terminal in PostgreSQL.

Stream entries survive independent Core/agent process restarts while Redis is
running. Surviving a Redis service or data-volume restart additionally depends
on the operator's Redis persistence policy; the supplied Compose/new-pod setup
enables AOF, but Core does not require or mutate that policy at startup.

The Android `/device/ws` relay remains a separate device bridge. It is not Core-to-agent orchestration and stays in place so the existing companion app does not change endpoints. The old device `/v1/delegate` HTTP endpoint remains temporarily for migration compatibility, but production Core delegation uses Redis only.

Text clients can subscribe to `GET /chat/updates?conversationId=<uuid>` as a WebSocket. Each update includes the persisted assistant `messageId`, conversation ID, message, and timestamp. On reconnect, pass `afterMessageId=<last-seen-message-id>` to resume from PostgreSQL; `limit` defaults to 50 and is capped at 100. With no cursor, Core replays the most recent bounded window. The replay query includes only assistant messages finalized from agent responses, not foreground `/chat` responses, and Core buffers concurrent live updates until replay finishes so there is no subscribe gap. Messages on this socket are authored and persisted by Core; Redis and worker processes are never exposed to the client, and a failed socket or listener cannot roll back agent-response processing.

The V0.3 runtime keeps Core's catalog intentionally small. Core owns
execution-control, people resolution, web research, self/repository inspection,
and `delegate_to_agent`. `device-agent` owns the connected Android surface;
`google-agent` owns the currently registered Google Sheets operations
(`sheets_find`, `sheets_create`, `sheets_read`, `sheets_add_tab`, and
`sheets_update`). The older fixed-schema `record_expense`/`expense_report`
adapters remain in source for incremental migration and tests, but they are not
registered in the current runtime.

These skills wrap the existing Shiva brain. Text and voice requests still use the same `ShivaChatService`, conversation ID, working memory, long-term memory retrieval, persistence, cancellation, and response transport. The feature does not create a second chat or memory implementation.

## Request flow

```text
POST /chat or voice turn
          |
          v
resolve user/conversation -> save message -> load memory -> build context
          |
          v
bounded AgentLoop -> planner sees actual registered catalog
          |
          +-> direct_chat -----------> existing Ollama/Gemma stream
          +-> describe_capabilities -> registry-derived answer
          +-> clarify ---------------> one user-facing question
          +-> first skill_call ------> validate + freeze capability pack(s)
                                             |
                                  input schema + execution policy
                                             |
                                        SkillExecutor
                                             |
                                  structured tool observation
                                             |
                                  next bounded planner step
                                             |
                                  evidence-gated final response
          |
          v
save assistant message -> existing memory scheduling
```

There is no keyword or regex intent router. Every non-explicit-memory turn reaches the planner with the real registered skill catalog and a truthful `configured` flag for each integration. The model decides semantically whether the request needs a skill. Tool-free conversation is delegated to the existing streaming provider, skill/capability questions use a deterministic registry summary, and incomplete action requests can produce one clarification without claiming execution.

`open_packs` reveals the skill contracts in one or more capability packs without executing anything. On the first `skill_call`, the loop freezes those packs, while every registered skill inside them remains callable for discovered chains such as `sheets_find` → `sheets_read` → `sheets_update`. This lets Shiva list a workbook's exact tab names, inspect the selected tab's live header/current structure, and then align a write without guessing a default tab. `sheets_update` requires an explicit mode: `update` writes exactly the requested cells, while `append` adds complete rows to the logical table. If the planner directly calls known skills before `open_packs`, the loop validates `selectedSkills` and freezes the union of every represented pack rather than only the called skill's pack. `selectedSkills` remains evidence/planning metadata and may grow within the frozen packs; it is not the execution-authority boundary. The executor independently receives the concrete allowed skill names and retains `SKILL_NOT_AUTHORIZED_FOR_REQUEST` as defense in depth.

Malformed planner JSON or a decision that does not match the decision schema is retried once within the same request deadline. The narrow Gemma error where `type` equals a currently visible skill is normalized to `skill_call`; the redundant `skill` field may be filled from that visible discriminator, after which the entire object still passes strict schema validation. After tool evidence exists, Gemma's `direct_chat` plus `message` terminal alias is normalized to `respond`; before execution, that alias remains invalid. Normal streaming fallback exists only while no capability pack has been opened and execution has not started. Opening a pack marks the turn as an execution run; if the retry still fails or the run reaches its step ceiling without an observation, Shiva deterministically reports that no action executed instead of asking ordinary chat to compose a result. After an observation exists, a second invalid response stops with the preserved evidence (or the exact pending-confirmation question) instead of spending the rest of the 12-step budget. Other recoverable contract violations become precise `correctionRequired` feedback; rejected decisions never execute.

The loop also canonicalizes each skill name plus JSON arguments into a per-run replay key. An identical repeated call is not sent to the executor or external integration again. Shiva receives feedback that the existing success/failure observation must be used, preventing repeated unavailable web calls and protecting write skills from accidental same-run duplication. Materially different arguments remain distinct operations.

The planner emits one validated `direct_chat`, `describe_capabilities`, `clarify`, `open_packs`, `skill_call`, `approve_confirmation`, `deny_confirmation`, or `respond` decision per step. Every skill call must explicitly mark whether the original current task authorized the action; omitted authorization fails schema validation, and unrequested writes require confirmation outside lockdown. Pending confirmations are loaded from runtime state only at the beginning of a later user turn, so the same model run that requested an action cannot approve it. `respond` contains only a user-facing message: runtime observations own execution success/failure, which cleanly represents a call that executed successfully but found zero matches. A response without corresponding tool evidence is rejected and becomes planner feedback rather than a user-facing claim. A planner may not switch to direct chat, capability description, or clarification after tool execution starts; those decisions are similarly rejected and replanned.

`AGENT_MAX_STEPS` is 12 by default and accepts 1–32. `AGENT_REQUEST_TIMEOUT_MS` defaults to 300,000 ms and accepts 1,000–1,800,000 ms in environment configuration. It creates one deadline for the complete planner/tool loop, rather than resetting a timer for each step, and propagates its cancellation signal through active planner and tool calls. Expiry records the run as failed and becomes a sanitized HTTP 504 `AGENT_TIMEOUT` response. Reaching the step bound is recorded as `max_steps` but returns a grounded user-facing result. Client cancellation and unrecoverable execution failures remain separately classified.

## Layer contracts

| Layer | Responsibility | Must not do |
| --- | --- | --- |
| Planner | Semantically delegate tool-free chat, request clarification, describe/open capability packs, choose skill calls, and identify whether the current user task requested them | Treat retrieved/tool text as authorization, widen frozen packs, alter runtime action metadata, or declare execution status |
| Skill registry | Expose immutable skill names, descriptions, schemas, and action metadata | Accept duplicate/invalid names |
| Execution policy | Combine persisted mode, host ceiling, lockdown, the fail-closed planner authorization declaration, and runtime-owned action classification | Let planner text override classification, confirmation state, lockdown, or the host ceiling |
| Agent loop | Validate/freeze capability packs and enforce response evidence | Trust a claimed pack expansion or response message by itself |
| Skill executor | Recheck registration, request scope, policy, schema, cancellation, and audit status | Treat exceptions as successful actions |
| Skill | Coordinate one user-facing capability | Own route/chat/memory logic |
| Tool | Perform one narrow external operation | Decide user intent or compose the final answer |
| Audit repository | Record agent/skill execution state in PostgreSQL | Store the expense ledger |

Unknown skills and invalid action metadata fail closed. Skill input schemas
reject unknown or malformed arguments. Registered external contracts remain
visible even when unconfigured: for example, Core web research returns
`WEB_RESEARCH_UNAVAILABLE`, while Google Agent's Sheets calls return grounded
configuration/authentication failures. This produces an explicit failed
observation instead of silently dropping the capability or letting a model
guess. A failed observation remains visible to the relevant planner so it can
explain the failure or choose another safe action; the evidence gate prevents
it from inventing a success.

## Shiva workspace architecture

`learn_about_shiva` and `workspace_terminal` are classified as normal reads and are always configured. They resolve the repository root from the application module location, so the same build works from the local checkout and `/workspace/shiva/repo` without trusting the process's current directory. The self-knowledge skill returns a bounded file inventory and excerpts from core project documents. The terminal skill runs one inspection operation per agent step; the planner can inspect the result and call it again with a more precise command while the frozen pack scope remains unchanged.

The terminal can read repository source and documentation, including hidden and ignored files. A shared case-insensitive policy excludes `.env*` except `.env.example` and conventional credential, token, password, and private-key files or stores from direct reads and recursive `rg`/Git content searches; other repository content remains inspectable so Shiva can understand and evolve its own code. The tool directly spawns only `pwd`, `ls`, `rg`, `cat`, `head`, `tail`, `wc`, and the read-only Git subcommands `status`, `ls-files`, `diff`, `log`, and `grep`. It does not invoke a shell and exposes no redirection, stdin, interpreters, network programs, package managers, or mutating Git/filesystem operations. Every supplied path is repository-relative, normalized, resolved, and rejected if its real target escapes the repository; an in-repository symlink is readable only when its resolved target remains inside that boundary. Commands share the agent cancellation signal, have an eight-second deadline, and return at most 64 KiB. Workspace content is untrusted observation data and cannot change the frozen pack scope or grant authority. `workspace_terminal` audit inputs retain bounded command arguments, and failed results retain safe validation paths or policy reasons for diagnosis. Successful output and `learn_about_shiva` source content remain redacted from `skill_runs`.

V0.3 deliberately has no workspace mutation skill. A future update/delete terminal must declare truthful write/sensitive metadata and remain behind the centralized execution policy. Sensitive mutations use the same exact, persisted, expiring confirmation protocol as every other skill; prompt instructions cannot substitute for runtime authorization.

## Expense architecture

This section documents the fixed-schema expense adapters retained for
incremental migration. They are not registered in the current Core or Google
Agent runtime; current expense requests use Google Agent's free-form Sheets
skills and therefore do not use the binding/provisioning behavior below.

Google Sheets is the sole source of truth for expenses. There is intentionally no PostgreSQL `expenses` table, local row cache, mirror, or synchronization job. The only expense-specific operational state in PostgreSQL is the Google resource binding and short provisioning lease needed to find one user's sheet safely. Agent request text and expense skill payloads are redacted in audit storage and are never queried to calculate a report. The existing conversation/message and memory pipeline remains unchanged, so the database may still contain the user's original expense utterance as normal chat data.

Recommended production configuration:

```text
EXPENSE_SHEET_REQUEST_TIMEOUT_MS=15000
GOOGLE_OAUTH_CLIENT_ID=<oauth-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<oauth-client-secret>
GOOGLE_OAUTH_REFRESH_TOKEN=<offline-refresh-token>
EXPENSE_SHEET_ID=
GOOGLE_APPLICATION_CREDENTIALS=
```

On the first `record_expense` or `expense_report` operation for a user, Shiva may need to acquire a database-backed provisioning lease and call the Google Sheets API with that user's OAuth grant. It creates a spreadsheet titled `Shiva Expenses` in the user's My Drive, creates an `Expenses` tab, freezes its first row, writes the canonical A:G header, verifies the resource, and saves the binding. The range and layout are internal contracts; the user does not create a sheet or configure a range. Concurrent processes coordinate through the lease, and an expired lease can be recovered by a later request. Because provisioning changes Google and database state, the runtime classifier marks a report that would provision, adopt, or upgrade resources as a normal write before policy evaluation; a report against a ready binding remains a normal read.

The managed first row is:

| A | B | C | D | E | F | G |
| --- | --- | --- | --- | --- | --- | --- |
| `expense_id` | `occurred_at` | `amount` | `currency` | `description` | `category` | `source` |

Each data row uses:

- a generated expense identifier;
- an RFC3339 timestamp;
- a positive amount with exactly two normalized decimal places;
- a three-letter uppercase currency code;
- a required description;
- an optional category;
- source `Shiva` for rows created by Shiva.

### Record semantics

`record_expense` is classified as a normal write. Its tool:

1. obtains a short-lived Google access token from the configured user OAuth refresh token (or Application Default Credentials on the legacy path);
2. reads and validates the live A:G header immediately before mutation;
3. appends one row with `RAW` value handling and `INSERT_ROWS`;
4. validates that Google reports a single updated A:G row;
5. reads that exact updated range back;
6. compares all seven returned cells with the intended row;
7. returns success only after the comparison passes.

An authentication, timeout, cancellation, malformed response, or failed readback never produces a success confirmation.

### Report semantics

`expense_report` rereads the live sheet, validates every non-empty row, optionally filters an inclusive `from` and exclusive `until` timestamp, and sorts newest first. Its ready-ledger execution metadata is a normal read; the first-use provisioning path is truthfully reclassified as a normal write. Totals and `matchedCount` cover every matched row using integer minor units; the 1–25 `limit` (default 25) and 8,000-character serialized detail budget apply only to individual rows returned to the planner. The detail list stops before either bound is exceeded. Currencies remain separate. There is no approximate floating-point summation and no implicit currency conversion.

### Google setup and binding

The recommended authorization model is a one-time Google user OAuth grant with offline access and only `https://www.googleapis.com/auth/drive.file`. That scope lets this app manage files it creates or that the user explicitly opens with it; Shiva neither needs nor requests a Google password or full-account access.

1. Enable the Google Sheets API, configure the OAuth consent screen, and create an OAuth 2.0 client in a Google Cloud project.
2. Run a one-time consent flow for the intended Google user using the `drive.file` scope and offline access, then store the resulting client ID, client secret, and refresh token in the three `GOOGLE_OAUTH_*` environment variables.
3. Leave `EXPENSE_SHEET_ID` and `GOOGLE_APPLICATION_CREDENTIALS` empty so Shiva owns provisioning.
4. Apply the binding/audit migrations, then start Shiva:

   ```bash
   cd app
   npm install
   npm run build
   npm run db:migrate
   npm start
   ```

5. Send the first expense request. Creation, initialization, verification, and binding happen lazily.

The OAuth trio is all-or-none; a partial trio prevents startup. If no complete user OAuth trio and no legacy sheet ID is configured, both expense contracts remain registered but return `EXPENSE_SHEET_UNAVAILABLE` without contacting Google. An External OAuth consent screen left in Testing can yield refresh tokens that expire after seven days, so use the appropriate published consent state for a stable deployment.

`expense_sheet_bindings` stores only `user_id`, the spreadsheet and tab IDs, provisioning/ready status, schema version, lease owner/expiry, and timestamps. Expense rows, OAuth client secrets, refresh tokens, and access tokens are never stored there. Keep OAuth secrets outside Git, logs, prompts, client responses, and database records.

For migration from an existing manually managed ledger, `EXPENSE_SHEET_ID` plus `GOOGLE_APPLICATION_CREDENTIALS` remains a legacy bootstrap path. The operator creates and shares the spreadsheet with the service-account email as Editor, then sets its ID. During first adoption Shiva can add a missing `Expenses` tab, initialize an empty header, and freeze row 1; a populated noncanonical header is rejected rather than overwritten. A bootstrap ID that conflicts with an existing durable binding fails closed rather than switching a user to another ledger. When both user OAuth and a sheet ID are supplied, user OAuth is used to access and adopt that specific sheet.

## Web research architecture

Production configuration:

```text
BRAVE_SEARCH_API_KEY=<server-side-secret>
BRAVE_SEARCH_URL=https://api.search.brave.com
WEB_REQUEST_TIMEOUT_MS=15000
WEB_MAX_CONTENT_BYTES=524288
```

The `web_research` contract always remains registered and is classified as a normal read. Without `BRAVE_SEARCH_API_KEY`, execution returns the safe `WEB_RESEARCH_UNAVAILABLE` observation without making a search request. When configured, it can perform one primary query and up to two alternate queries, deduplicate result URLs, and return evidence from up to six sources. The planner must cite the source URLs that contributed to its answer.

`web.search` calls Brave's Web Search endpoint with moderate SafeSearch and the key in the server-side `X-Subscription-Token` header. `web.open` is a limited evidence fetcher:

- public HTTP(S) only;
- no embedded URL credentials;
- local/private/link-local/reserved destinations rejected after DNS lookup;
- redirect targets revalidated, with a three-redirect maximum;
- HTML, XHTML, and plain text only;
- response body limited by `WEB_MAX_CONTENT_BYTES`;
- scripts, styles, and markup removed before returning evidence.

Opened evidence is capped at 6,000 characters per source and 16,000 characters across the complete research observation. Search snippets are capped separately when used as a fallback for an unreadable result.

All conversation text, search snippets, opened pages, and tool-result content is treated as untrusted data, never as an instruction or authority grant. Text found on a page cannot expand the allowed skill set, trigger an expense write, or create a new objective; only an explicit write in the original user request can authorize the write skill for that run. It does not execute JavaScript, log in, retain cookies, submit forms, or act as a full browser. Network-level egress controls are still recommended for deployments with untrusted users.

## Execution control

The current global mode (`SAFE`, `AUTO`, or `FULL_ACCESS`) and lockdown flag are stored in PostgreSQL together with a monotonic settings revision. `SHIVA_MAX_EXECUTION_MODE` is a host-controlled ceiling, and the effective mode is the lower of the stored and configured values. Every skill declares only `read|write` mutability plus `normal|sensitive` impact—there is no granular permission-key matrix.

Normal reads execute. A normal write in `SAFE` asks for confirmation; a clearly requested normal write in `AUTO` or `FULL_ACCESS` executes directly. Unrequested writes and every sensitive action create an exact confirmation bound to the user, conversation, validated skill arguments, runtime classification, settings revision, and expiry. Approval is atomically claimed as `EXECUTING` and finishes as `EXECUTED` or `FAILED`, so it cannot be replayed; changed arguments, expiry, a settings change, or increased runtime risk makes it unusable. Execution-control changes commit with compare-and-set, and ordinary writes recheck the settings revision immediately before starting. Entering lockdown is immediate and invalidates pending approvals; ordinary writes remain blocked until leaving lockdown is confirmed. Mode increases and lockdown exits require confirmation, while authority reductions are immediate. Execution control does not replace HTTP authentication or provider/OS capability boundaries. Keep Shiva on localhost/private infrastructure until authentication and user authorization are added.

## Audit logging

Drizzle migrations add these control-plane tables:

- `agent_runs`: request, user/conversation IDs, status, step count, error code, start/finish timestamps, and duration;
- `skill_runs`: parent agent run, skill name, sanitized arguments/result, effective mode, action classification, confirmation ID, status, error code, timestamps, and duration;
- `system_settings`: the singleton persisted execution mode, lockdown state, and monotonic revision;
- `action_confirmations`: exact, expiring, revision-bound action approvals and their one-shot lifecycle;
- `expense_sheet_bindings`: one per-user Google spreadsheet/tab pointer, schema state, and provisioning lease.

Statuses distinguish success, failure, cancellation, denial, and max-step exhaustion where applicable. `agent_runs.request` always uses a constant redacted marker because every ordinary turn now reaches planning. Audit values are bounded and recursively sanitized for credential-shaped fields, labeled secrets, credential-bearing URLs, private keys, JWTs, and common provider-token formats; error codes and confirmation reasons use the same text sanitizer. Web skill runs may contain bounded inputs/results; expense skill runs use constant redacted payloads rather than ledger rows. Workspace terminal runs store only bounded commands/arguments and safe rejection diagnostics, never captured source output. Database access and retention must still be managed accordingly. The binding table contains resource IDs and coordination state only. None of these tables replaces or copies the Google expense ledger, and none stores Google tokens. This audit redaction does not alter the existing conversation/message or memory records created by the shared chat pipeline.

Apply committed Drizzle migrations before running this feature against a real database:

```bash
cd app
npm install
npm run typecheck
npm run build
npm run db:migrate
npm start
```

For development from TypeScript, use `npm run db:migrate:dev` and `npm run dev` instead.

## Example requests

```bash
curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Add ₹350 for coffee to my expenses."}'

curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What expenses have I recorded today?"}'

curl --no-buffer -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Research current RTX 3090 rental prices and cite sources."}'
```

The same requests can enter through the voice conversation path; voice only changes response style and TTS delivery, not skill semantics.

## Verification and limitations

The test suite uses mocks for Google authorization/Sheets responses, Brave responses, page retrieval, DNS, planners, and databases. It verifies contracts such as single-flight sheet provisioning, durable binding/lease behavior, fresh expense reads, append/readback, exact totals, execution-mode decisions, exact confirmation replay protection, bounded agent decisions, audit lifecycle, and cross-skill observations without external credentials or model downloads.

Those tests do not prove live Google Sheets, Brave Search, Ollama/Gemma, PostgreSQL, or RunPod configuration. Verify each configured service separately in the deployment environment. Current limitations include no in-app Google OAuth enrollment/refresh-token setup UI, no expense edit/delete, no currency conversion, no trusted-device/passkey confirmation UI, no arbitrary skill discovery, no JavaScript browser, no authenticated web sources, and no general-purpose autonomous background agent.
