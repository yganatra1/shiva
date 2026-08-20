# Security and permission policy

The model can propose a registered skill call, but it is never the authority that permits execution. The deterministic `SkillExecutor` owns the enforcement order:

```text
planner proposes skill + arguments
              |
              v
registered skill? -> allowed for this request? -> declared permissions
                                                      |
                                                      v
                                                policy decision
                                                      |
                                                      v
                                                 input schema
                                                      |
                                                      v
                                                 skill executes
                                                      |
                                                      v
                                          observation + evidence gate
```

The current permission registry is intentionally small:

| Permission | Used by | Default |
| --- | --- | --- |
| `web.read` | `web_research` | `auto` |
| `expenses.read` | `expense_report` | `auto` |
| `expenses.write` | `record_expense` | `auto` |

Unknown permissions fail closed. A permission configured as `deny` is rejected. A permission configured as `confirm` is also rejected with `CONFIRMATION_REQUIRED`, because V0.3 deliberately does not invent a confirmation UI. Permission approval cannot expand the skills explicitly allowed by the original request. The request-scope and policy checks happen before schema validation and before any external tool is called.

An out-of-scope planner skill call terminates the agent loop immediately as `AGENT_INVALID_RESPONSE`, before the executor or any tool runs. The executor retains its own request-scope denial as defense in depth. All skill arguments then pass through strict Zod schemas. Built-in contracts remain registered even when Google Sheets or Brave is not configured, but execution returns a safe unavailable observation without contacting the missing integration. Tool failures become sanitized skill observations. The agent loop—not only the planner prompt—rejects a success response until every skill required by the explicit intent has at least one `success=true` observation. A failure response needs at least one failed required-skill observation, so a dependent chain can terminate safely without executing later steps after a prerequisite fails. Every run is bounded both by `AGENT_MAX_STEPS` (1–32, default 8) and by one `AGENT_REQUEST_TIMEOUT_MS` deadline shared by all planner/tool steps (startup range 1,000–1,800,000 ms; default 300,000 ms). The deadline signal propagates to active work, and expiry is exposed only as the sanitized `AGENT_TIMEOUT` response.

## Audit boundary

PostgreSQL stores agent control-plane history, not an expense ledger:

- `agent_runs` records the user request, conversation/user IDs, status, step count, error code, and timing;
- `skill_runs` records the selected skill, arguments, declared permissions, sanitized result, status, error code, and timing;
- `expense_sheet_bindings` records only the per-user Google spreadsheet/tab IDs, schema/status values, and a short provisioning lease.

Agent and skill rows can contain personal request content and skill inputs/results for non-expense tools. Expense-routed audits are explicitly redacted: `agent_runs.request` uses a constant placeholder, while `skill_runs` retains only constant or minimal input/result metadata rather than expense descriptions, amounts, or returned rows. Protect the database, limit operator access, and apply an explicit retention policy before broader deployment. The binding table contains no expense rows, OAuth client secret, refresh token, or access token. None of these tables caches or mirrors the Google expense sheet. The ordinary conversation/message and memory path is intentionally unchanged, so the user's original expense utterance may still exist as chat data.

## External-service boundaries

Google user OAuth is the recommended expense authorization path. Request offline access with only `https://www.googleapis.com/auth/drive.file`, then keep `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` outside the repository, database, logs, prompts, images, and client responses. Shiva does not need and must never request the user's Google password or unrestricted account credentials. The complete OAuth trio lets Shiva create `Shiva Expenses` in that user's My Drive and manage only files within the grant. A partial trio is rejected at startup. Be aware that an External OAuth app left in Testing can receive refresh tokens that expire after seven days.

`EXPENSE_SHEET_ID` with Application Default Credentials is a legacy bootstrap path for a spreadsheet shared with a service account as Editor. Keep its JSON key outside the repository and set `GOOGLE_APPLICATION_CREDENTIALS` to its protected absolute path. If an OAuth trio and a bootstrap ID are both set, user OAuth is used. A bootstrap ID that conflicts with the durable per-user binding fails closed; Shiva does not silently switch ledgers. Missing both a complete OAuth trio and the legacy sheet ID produces `EXPENSE_SHEET_UNAVAILABLE` without contacting Google.

First use is lazy and lease-coordinated: Shiva creates or adopts the spreadsheet, ensures the `Expenses` tab, canonical A:G header, and frozen row, then stores only Google resource IDs and provisioning state. Once bound, unexpected changes to the tab ID, header, or frozen-row invariant fail closed. Each report reads the live sheet, and each append is considered successful only after Shiva reads the exact appended A:G row back and verifies every cell.

The Brave key remains server-side. Public page fetching rejects URL credentials and local/private/reserved destinations after DNS resolution, checks redirects again, limits content types and bytes, and applies deadlines. Evidence is bounded before it enters the planner. Conversation text, web pages, search snippets, and tool results are all untrusted data: none can grant permission, widen the request scope, authorize an expense write, or create a new objective. Production network egress rules remain advisable because application-level URL validation alone is not a complete sandbox.

## Current limitations

Shiva still has no end-user authentication, role system, device trust, approval UI, or multi-user authorization boundary. The permission registry controls which code paths may run; it does not authenticate the person sending the request. The API and both Python voice services therefore bind to localhost by default and should be exposed only through a trusted private tunnel or authenticated reverse proxy.
