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

Unknown permissions fail closed. A permission configured as `deny` is rejected. A permission configured as `confirm` is also rejected with `CONFIRMATION_REQUIRED`, because V0.3 deliberately does not invent a confirmation UI. Every ordinary turn reaches semantic planning; the model proposes the minimal skill set from the original request, and the agent loop validates and freezes it on the first skill call. Permission approval cannot expand that frozen set. Scope and policy checks happen before schema validation and before any external tool is called.

An unknown skill, malformed scope, or attempt to change the frozen scope terminates the loop as `AGENT_INVALID_RESPONSE` before any tool runs. The executor retains its own request-scope denial as defense in depth. All arguments pass through strict Zod schemas. Built-in contracts remain registered even when Google Sheets or Brave is not configured, but execution returns a safe unavailable observation without contacting the missing integration. Tool failures become sanitized observations. The agent loop rejects a success response until every selected skill has at least one `success=true` observation; a failure response needs a failed selected-skill observation. Tool-free conversation is delegated to the existing provider stream, capability answers are generated from the registry rather than model folklore, and clarification cannot claim execution. Every run remains bounded by `AGENT_MAX_STEPS` and one shared `AGENT_REQUEST_TIMEOUT_MS` deadline.

## Audit boundary

PostgreSQL stores agent control-plane history, not an expense ledger:

- `agent_runs` records a constant redacted request marker, conversation/user IDs, status, step count, error code, and timing;
- `skill_runs` records the selected skill, arguments, declared permissions, sanitized result, status, error code, and timing;
- `expense_sheet_bindings` records only the per-user Google spreadsheet/tab IDs, schema/status values, and a short provisioning lease.

Agent request text is always redacted in `agent_runs`. Non-expense `skill_runs` can still contain tool inputs/results; expense skill payloads retain only constant or minimal redacted metadata rather than descriptions, amounts, or returned rows. Protect the database, limit operator access, and apply an explicit retention policy. The binding table contains no expense rows or Google tokens. The ordinary conversation/message and memory path is intentionally unchanged, so the original utterance may still exist as chat data.

## External-service boundaries

Google user OAuth is the recommended expense authorization path. Request offline access with only `https://www.googleapis.com/auth/drive.file`, then keep `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` outside the repository, database, logs, prompts, images, and client responses. Shiva does not need and must never request the user's Google password or unrestricted account credentials. The complete OAuth trio lets Shiva create `Shiva Expenses` in that user's My Drive and manage only files within the grant. A partial trio is rejected at startup. Be aware that an External OAuth app left in Testing can receive refresh tokens that expire after seven days.

`EXPENSE_SHEET_ID` with Application Default Credentials is a legacy bootstrap path for a spreadsheet shared with a service account as Editor. Keep its JSON key outside the repository and set `GOOGLE_APPLICATION_CREDENTIALS` to its protected absolute path. If an OAuth trio and a bootstrap ID are both set, user OAuth is used. A bootstrap ID that conflicts with the durable per-user binding fails closed; Shiva does not silently switch ledgers. Missing both a complete OAuth trio and the legacy sheet ID produces `EXPENSE_SHEET_UNAVAILABLE` without contacting Google.

First use is lazy and lease-coordinated: Shiva creates or adopts the spreadsheet, ensures the `Expenses` tab, canonical A:G header, and frozen row, then stores only Google resource IDs and provisioning state. Once bound, unexpected changes to the tab ID, header, or frozen-row invariant fail closed. Each report reads the live sheet, and each append is considered successful only after Shiva reads the exact appended A:G row back and verifies every cell.

The Brave key remains server-side. Public page fetching rejects URL credentials and local/private/reserved destinations after DNS resolution, checks redirects again, limits content types and bytes, and applies deadlines. Evidence is bounded before it enters the planner. Conversation text, web pages, search snippets, and tool results are untrusted data: none can grant permission, widen an already-frozen scope, authorize an expense write, or create a new objective. Production network egress rules remain advisable because application-level URL validation alone is not a complete sandbox.

## Current limitations

Shiva still has no end-user authentication, role system, device trust, approval UI, or multi-user authorization boundary. The permission registry controls which code paths may run; it does not authenticate the person sending the request. The API and both Python voice services therefore bind to localhost by default and should be exposed only through a trusted private tunnel or authenticated reverse proxy.
