# Shiva agent and skill architecture

## Purpose

The V0.3 agent layer lets Shiva perform a small set of controlled, observable actions without turning the chat server into a general-purpose autonomous runtime. It currently supports:

- `record_expense`: append and verify one row in a private Google Sheet;
- `expense_report`: read fresh expense rows and calculate exact totals per currency;
- `web_research`: search and inspect current public web sources.

These skills wrap the existing Shiva brain. Text and voice requests still use the same `ShivaChatService`, conversation ID, working memory, long-term memory retrieval, persistence, cancellation, and response transport. The feature does not create a second chat or memory implementation.

## Request flow

```text
POST /chat or voice turn
          |
          v
resolve user/conversation -> save message -> load memory -> build context
          |
          v
deterministic intent router
    | ordinary chat                         | clear expense/current-web intent
    v                                       v
Ollama/Gemma streaming          derive allowed + required skills
                                             |
                                      bounded AgentLoop
                                             |
                                   planner emits one JSON decision
                                      /                 \
                               skill_call              respond
                                   |                       |
                            SkillExecutor                  v
                     request scope + permission        evidence gate
                           + input checks                   |
                                   |                       v
                                   |                  final answer
                                   v
                          tool executes and returns
                          structured observation
                                   |
                          next bounded planner step
          |
          v
save assistant message -> existing memory scheduling
```

The router is deliberately narrow. It identifies clear expense/action language and explicit current-web language; normal conversation remains on the existing provider stream. From the original user request it derives the skills both allowed and required for that run. A write intent allows/requires `record_expense`, a read/report intent allows/requires `expense_report`, and explicit current-web intent allows/requires `web_research`; a request can require more than one of these. The planner receives only the scoped skill contracts and prior structured observations. If it nevertheless selects an out-of-scope skill, the agent loop terminates immediately with `AgentEvidenceError` (sanitized publicly as `AGENT_INVALID_RESPONSE`) before the executor or any tool runs. The executor independently retains `SKILL_NOT_AUTHORIZED_FOR_REQUEST` as defense in depth for direct or future call paths.

The planner can emit exactly one `skill_call` or `respond` decision at each step, in a validated JSON shape. A response declares `success` or `failure`, but that declaration is not trusted by itself. The agent loop accepts a success response only when every required skill has at least one successful observation. It accepts a failure response after at least one required skill has a failed observation; later dependent skills do not need to be attempted when that failure makes them unsafe or impossible to complete. A response without the corresponding evidence raises `AgentEvidenceError` rather than making an unsupported claim.

`AGENT_MAX_STEPS` is 8 by default and accepts 1–32. `AGENT_REQUEST_TIMEOUT_MS` defaults to 300,000 ms and accepts 1,000–1,800,000 ms in environment configuration. It creates one deadline for the complete planner/tool loop, rather than resetting a timer for each step, and propagates its cancellation signal through active planner and tool calls. Expiry records the run as failed and becomes a sanitized HTTP 504 `AGENT_TIMEOUT` response. Reaching the step bound ends the run as `max_steps`; client cancellation and other failures are separately classified. The final agent answer uses the existing chat response path and is persisted like any other assistant message.

## Layer contracts

| Layer | Responsibility | Must not do |
| --- | --- | --- |
| Intent router | Decide whether a clear request needs the agent loop and derive its allowed/required skills | Execute tools or infer tool success |
| Planner | Choose one scoped skill call or a typed success/failure response | Bypass the request scope, evidence gate, or permissions |
| Skill registry | Expose immutable skill names, descriptions, schemas, and permissions | Accept duplicate/invalid names |
| Permission policy | Deterministically allow or reject declared permissions | Delegate authorization to the model |
| Agent loop | Terminate an out-of-scope planner call before execution and enforce response evidence | Trust the planner's claimed outcome by itself |
| Skill executor | Recheck registration, request scope, policy, schema, cancellation, and audit status | Treat exceptions as successful actions |
| Skill | Coordinate one user-facing capability | Own route/chat/memory logic |
| Tool | Perform one narrow external operation | Decide user intent or compose the final answer |
| Audit repository | Record agent/skill execution state in PostgreSQL | Store the expense ledger |

Unknown skills and permissions fail closed. Skill input schemas reject unknown or malformed arguments. Built-in skill contracts remain registered even when their external integration is not configured: expense execution returns `EXPENSE_SHEET_UNAVAILABLE`, and research returns `WEB_RESEARCH_UNAVAILABLE`. This produces an explicit failed observation instead of silently dropping the capability or letting normal chat guess. A failed observation remains visible to the planner so it can explain the failure or choose another safe action; the evidence gate prevents it from inventing a success.

## Expense architecture

Google Sheets is the sole source of truth for expenses. There is intentionally no PostgreSQL `expenses` table, local row cache, mirror, or synchronization job. The only expense-specific operational state in PostgreSQL is the Google resource binding and short provisioning lease needed to find one user's sheet safely. Expense-routed audit payloads are redacted and are never queried to calculate a report. The existing conversation/message and memory pipeline remains unchanged, so the database may still contain the user's original expense utterance as normal chat data.

Recommended production configuration:

```text
EXPENSE_SHEET_REQUEST_TIMEOUT_MS=15000
GOOGLE_OAUTH_CLIENT_ID=<oauth-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<oauth-client-secret>
GOOGLE_OAUTH_REFRESH_TOKEN=<offline-refresh-token>
EXPENSE_SHEET_ID=
GOOGLE_APPLICATION_CREDENTIALS=
```

On the first `record_expense` or `expense_report` operation for a user, Shiva acquires a database-backed provisioning lease and calls the Google Sheets API with that user's OAuth grant. It creates a spreadsheet titled `Shiva Expenses` in the user's My Drive, creates an `Expenses` tab, freezes its first row, writes the canonical A:G header, verifies the resource, and saves the binding. The range and layout are internal contracts; the user does not create a sheet or configure a range. Concurrent processes coordinate through the lease, and an expired lease can be recovered by a later request.

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

`record_expense` requires `expenses.write`. Its tool:

1. obtains a short-lived Google access token from the configured user OAuth refresh token (or Application Default Credentials on the legacy path);
2. reads and validates the live A:G header immediately before mutation;
3. appends one row with `RAW` value handling and `INSERT_ROWS`;
4. validates that Google reports a single updated A:G row;
5. reads that exact updated range back;
6. compares all seven returned cells with the intended row;
7. returns success only after the comparison passes.

An authentication, timeout, cancellation, malformed response, or failed readback never produces a success confirmation.

### Report semantics

`expense_report` requires `expenses.read`. Each call rereads the live sheet, validates every non-empty row, optionally filters an inclusive `from` and exclusive `until` timestamp, and sorts newest first. Totals and `matchedCount` cover every matched row using integer minor units; the 1–25 `limit` (default 25) and 8,000-character serialized detail budget apply only to individual rows returned to the planner. The detail list stops before either bound is exceeded. Currencies remain separate. There is no approximate floating-point summation and no implicit currency conversion.

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

The `web_research` contract always remains registered and requires `web.read`. Without `BRAVE_SEARCH_API_KEY`, execution returns the safe `WEB_RESEARCH_UNAVAILABLE` observation without making a search request. When configured, it can perform one primary query and up to two alternate queries, deduplicate result URLs, and return evidence from up to six sources. The planner must cite the source URLs that contributed to its answer.

`web.search` calls Brave's Web Search endpoint with moderate SafeSearch and the key in the server-side `X-Subscription-Token` header. `web.open` is a limited evidence fetcher:

- public HTTP(S) only;
- no embedded URL credentials;
- local/private/link-local/reserved destinations rejected after DNS lookup;
- redirect targets revalidated, with a three-redirect maximum;
- HTML, XHTML, and plain text only;
- response body limited by `WEB_MAX_CONTENT_BYTES`;
- scripts, styles, and markup removed before returning evidence.

Opened evidence is capped at 6,000 characters per source and 16,000 characters across the complete research observation. Search snippets are capped separately when used as a fallback for an unreadable result.

All conversation text, search snippets, opened pages, and tool-result content is treated as untrusted data, never as an instruction or permission grant. Text found on a page cannot expand the allowed skill set, trigger an expense write, or create a new objective; only an explicit write in the original user request can authorize the write skill for that run. It does not execute JavaScript, log in, retain cookies, submit forms, or act as a full browser. Network-level egress controls are still recommended for deployments with untrusted users.

## Permissions

The deterministic policy defaults are:

| Permission | Default mode |
| --- | --- |
| `web.read` | `auto` |
| `expenses.read` | `auto` |
| `expenses.write` | `auto` |

Modes are `auto`, `confirm`, and `deny`. V0.3 has no confirmation interface, so `confirm` fails closed with `CONFIRMATION_REQUIRED`; `deny` and unknown permissions also fail closed. Permission approval does not override the per-request allowed-skill scope, and successful permission evaluation does not count as successful tool evidence. This permission layer is an execution policy, not user authentication. Keep Shiva on localhost/private infrastructure until authentication and user authorization are added.

## Audit logging

Drizzle migrations add these control-plane tables:

- `agent_runs`: request, user/conversation IDs, status, step count, error code, start/finish timestamps, and duration;
- `skill_runs`: parent agent run, skill name, arguments, declared permissions, sanitized result, status, error code, timestamps, and duration.
- `expense_sheet_bindings`: one per-user Google spreadsheet/tab pointer, schema state, and provisioning lease.

Statuses distinguish success, failure, cancellation, denial, and max-step exhaustion where applicable. Agent and skill records make cross-skill behavior inspectable, but they can contain personal request and tool data for non-expense skills; database access and retention must be managed accordingly. For an expense-routed run, `agent_runs.request` uses a constant placeholder and `skill_runs` uses constant or minimal redacted input/result payloads rather than expense descriptions, amounts, or returned rows. The binding table contains resource IDs and coordination state only. None of these tables replaces or copies the Google expense ledger, and none stores Google tokens. This audit redaction does not alter the existing conversation/message or memory records created by the shared chat pipeline.

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

The test suite uses mocks for Google authorization/Sheets responses, Brave responses, page retrieval, DNS, planners, and databases. It verifies contracts such as single-flight sheet provisioning, durable binding/lease behavior, fresh expense reads, append/readback, exact totals, permission denial, bounded agent decisions, audit lifecycle, and cross-skill observations without external credentials or model downloads.

Those tests do not prove live Google Sheets, Brave Search, Ollama/Gemma, PostgreSQL, or RunPod configuration. Verify each configured service separately in the deployment environment. Current limitations include no in-app Google OAuth enrollment/refresh-token setup UI, no expense edit/delete, no currency conversion, no interactive confirmations, no arbitrary skill discovery, no JavaScript browser, no authenticated web sources, and no general-purpose autonomous background agent.
