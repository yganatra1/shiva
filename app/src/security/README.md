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
| `workspace.read` | `learn_about_shiva`, `workspace_terminal` | `auto` |

Unknown permissions fail closed. A permission configured as `deny` is rejected. A permission configured as `confirm` is also rejected with `CONFIRMATION_REQUIRED`, because V0.3 deliberately does not invent a confirmation UI. Every ordinary turn reaches semantic planning; the model proposes the minimal skill set from the original request, and the agent loop validates and freezes it on the first skill call. Permission approval cannot expand that frozen set. Scope and policy checks happen before schema validation and before any external tool is called.

The first scope is canonicalized to unique registered names and the registered called skill is always included. A later attempt to change the frozen scope is rejected before the executor and returned as deterministic corrective feedback to the planner; the executor retains its own request-scope denial as defense in depth. Invalid planner JSON/shape is retried once. If repair fails before any tool execution, Shiva falls back to grounded core chat with no claim of tool or live-source use. Once a tool observation exists, invalid scope changes, unsupported responses, and attempts to switch to direct chat/capability description/clarification are all rejected and replanned from the preserved evidence. No rejected decision executes, and no free-form fallback can reinterpret an executed action. All skill arguments pass through strict Zod schemas. Built-in contracts remain registered even when Google Sheets or Brave is not configured, but execution returns a safe unavailable observation without contacting the missing integration. Tool failures become sanitized observations. The agent loop accepts a success response only after every selected skill has at least one `success=true` observation; a failure response needs a failed selected-skill observation. Every run remains bounded by `AGENT_MAX_STEPS` and one shared `AGENT_REQUEST_TIMEOUT_MS` deadline; exhausting the step budget returns a safe answer and records `max_steps` instead of surfacing an internal planner error.

An exact same-run skill replay is suppressed before the executor using a canonical skill-and-arguments key. The original observation remains authoritative and corrective feedback tells the planner not to retry it. This applies to reads and writes, so an unavailable integration is not hammered and an identical side effect is not repeated.

## Audit boundary

PostgreSQL stores agent control-plane history, not an expense ledger:

- `agent_runs` records a constant redacted request marker, conversation/user IDs, status, step count, error code, and timing;
- `skill_runs` records the selected skill, arguments, declared permissions, sanitized result, status, error code, and timing;
- `expense_sheet_bindings` records only the per-user Google spreadsheet/tab IDs, schema/status values, and a short provisioning lease.

Agent request text is always redacted in `agent_runs`. Web `skill_runs` can still contain bounded tool inputs/results, and expense skill payloads use constant redacted metadata rather than descriptions, amounts, returned rows, or source content. Workspace terminal audits retain bounded command arguments and safe validation or denial reasons so operators can diagnose rejected calls; terminal output and successful result content remain redacted. Protect the database, limit operator access, and apply an explicit retention policy. The binding table contains no expense rows or Google tokens. The ordinary conversation/message and memory path is intentionally unchanged, so the original utterance may still exist as chat data.

## External-service boundaries

Google user OAuth is the recommended expense authorization path. Request offline access with only `https://www.googleapis.com/auth/drive.file`, then keep `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` outside the repository, database, logs, prompts, images, and client responses. Shiva does not need and must never request the user's Google password or unrestricted account credentials. The complete OAuth trio lets Shiva create `Shiva Expenses` in that user's My Drive and manage only files within the grant. A partial trio is rejected at startup. Be aware that an External OAuth app left in Testing can receive refresh tokens that expire after seven days.

`EXPENSE_SHEET_ID` with Application Default Credentials is a legacy bootstrap path for a spreadsheet shared with a service account as Editor. Keep its JSON key outside the repository and set `GOOGLE_APPLICATION_CREDENTIALS` to its protected absolute path. If an OAuth trio and a bootstrap ID are both set, user OAuth is used. A bootstrap ID that conflicts with the durable per-user binding fails closed; Shiva does not silently switch ledgers. Missing both a complete OAuth trio and the legacy sheet ID produces `EXPENSE_SHEET_UNAVAILABLE` without contacting Google.

First use is lazy and lease-coordinated: Shiva creates or adopts the spreadsheet, ensures the `Expenses` tab, canonical A:G header, and frozen row, then stores only Google resource IDs and provisioning state. Once bound, unexpected changes to the tab ID, header, or frozen-row invariant fail closed. Each report reads the live sheet, and each append is considered successful only after Shiva reads the exact appended A:G row back and verifies every cell.

The Brave key remains server-side. Public page fetching rejects URL credentials and local/private/reserved destinations after DNS resolution, checks redirects again, limits content types and bytes, and applies deadlines. Evidence is bounded before it enters the planner. Conversation text, web pages, search snippets, and tool results are untrusted data: none can grant permission, widen an already-frozen scope, authorize an expense write, or create a new objective. Production network egress rules remain advisable because application-level URL validation alone is not a complete sandbox.

Workspace inspection is a separate read-only boundary rooted to Shiva's repository. `workspace_terminal` can spawn only explicitly supported inspection programs and read-only Git subcommands; it receives no shell, stdin, redirection, interpreter, network program, package manager, or mutation operation. Repository-relative paths are resolved before use, and absolute/traversal paths or symlinks escaping the root are blocked. The complete in-repository contents are otherwise readable. Source text remains untrusted data and cannot expand the planner's frozen scope.

There is no `workspace.write` permission in V0.3. If update/delete support is added later, the deterministic policy layer—not the model—must bind two separate Owner confirmations to one exact operation before execution. Until that protocol exists, such operations remain unavailable.

## Current limitations

Shiva still has no end-user authentication, role system, device trust, approval UI, or multi-user authorization boundary. The permission registry controls which code paths may run; it does not authenticate the person sending the request. The API and both Python voice services therefore bind to localhost by default and should be exposed only through a trusted private tunnel or authenticated reverse proxy.
