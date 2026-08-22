# Execution security

Shiva uses one global execution mode, not a per-tool permission matrix. Provider credentials, OAuth scopes, cloud IAM, operating-system permissions, and each adapter's own technical boundary still decide what Shiva can actually access. The execution mode decides how freely the runtime may use those already-connected capabilities.

The model may propose an action, but it is never the security authority. Every model provider goes through the same model-neutral runtime path:

```text
user request
    |
    v
planner -> frozen skill scope -> strict input validation
                                      |
                                      v
                         runtime-owned action metadata
                                      |
                                      v
                    execution state + central policy
                                      |
                         +------------+------------+
                         |                         |
                         v                         v
                  execute normally        exact confirmation
                         |                         |
                         +------------+------------+
                                      |
                                      v
                              sanitized audit
                                      |
                                      v
                           observation/evidence gate
```

No skill may bypass `SkillExecutor`. Registered skills declare only lightweight `SkillExecutionMetadata`:

```ts
{
  mutability: "read" | "write",
  impact: "normal" | "sensitive",
  confirmationReason?: string,
  control?: "execution_mode" | "lockdown"
}
```

The optional `control` tag lets the policy classify mode increases and lockdown exits from current persisted state instead of marking every settings change sensitive. This classification is owned by runtime code, not Gemma and not text retrieved from a prompt, conversation, file, or webpage. Shiva deliberately has no internal `email.send`, `drive.write`, `terminal.execute`, or similar permission-key matrix.

## Global execution modes

The ordering is `SAFE < AUTO < FULL_ACCESS`.

| Mode | Runtime behavior |
| --- | --- |
| `SAFE` | Normal reads and diagnostics execute. State-changing actions require an action-bound confirmation. Sensitive actions also require confirmation. |
| `AUTO` | Normal actions that the user explicitly requested, or that are a necessary ordinary part of completing that request, execute without repetitive prompts. Sensitive or materially escalated actions require confirmation. |
| `FULL_ACCESS` | Explicit ordinary reads and writes execute immediately when the underlying integration allows them. Sensitive or destructive actions still require confirmation. |

The semantic planner distinguishes an instruction such as “send this email” from a speculative statement such as “maybe we should send an email.” It must not initiate external work from discussion alone. The deterministic runtime still owns action classification, confirmation binding, lockdown, and the configured ceiling.

The stored mode and lockdown flag live in PostgreSQL's singleton `system_settings` row, so they survive API, PM2, Docker, and machine restarts. A missing row is initialized as `AUTO` with lockdown disabled. The row also carries a monotonic revision used for compare-and-set updates: concurrent control requests cannot overwrite a newer policy decision. `SHIVA_MAX_EXECUTION_MODE` is the host-controlled hard ceiling:

```text
effective mode = min(stored mode, SHIVA_MAX_EXECUTION_MODE)
```

The comparison uses the explicit ordering above, never string comparison. A request above the configured maximum is rejected. Lowering authority is immediate; increasing authority requires confirmation. The model cannot alter the environment ceiling or write settings tables directly.

## Sensitive actions and confirmation

`impact: "sensitive"` is a narrow final safeguard for high-impact or hard-to-reverse operations, not another permission system. Examples include wiping a database or disk, deleting a bucket or all backups, destructive restoration, terminating major infrastructure, changing credentials or security controls, financial transfers, raising the execution mode, and leaving lockdown.

An action that requires approval creates a PostgreSQL `action_confirmations` record bound to the user, conversation, registered skill, validated action hash, sanitized arguments, execution mode, settings revision, classification, sanitized reason, and expiry. `SHIVA_CONFIRMATION_TTL_MS` controls the lifetime and defaults to 300,000 ms (five minutes). Conversational approval applies only to that exact pending action:

- materially changed arguments do not match the stored action hash;
- expired or denied requests cannot execute;
- a change in execution settings or a riskier runtime reclassification makes the approval stale;
- approval is atomically claimed as `EXECUTING`, so concurrent or repeated approvals cannot execute it twice;
- a successful claimed action becomes `EXECUTED`; a claimed action that fails or is invalidated becomes `FAILED`, while an explicit rejection remains `DENIED`;
- approval never widens the planner's frozen skill scope;
- sanitized audit arguments are never treated as executable credentials or payloads.

The statuses are `PENDING`, `APPROVED`, `DENIED`, `EXPIRED`, `EXECUTING`, `EXECUTED`, and `FAILED`. Immediately before any allowed write starts, the executor rechecks the persisted settings revision. Execution-control skills also commit with compare-and-set against the exact revision evaluated by policy. The design keeps approval state separate from the model so a trusted-device or passkey approver can be added later without replacing the execution policy.

## Lockdown

Lockdown immediately stores `SAFE`, enables the lockdown flag, and invalidates pending confirmations so an old approval cannot survive the emergency transition. Reads and diagnostics remain available, while ordinary writes and external state changes are blocked. Enabling lockdown never needs confirmation. Leaving it requires an exact confirmation and cannot select a mode above `SHIVA_MAX_EXECUTION_MODE`.

Lockdown is intentionally stronger than ordinary `SAFE` mode: `SAFE` can offer a confirmation for a write, while lockdown blocks ordinary writes until the user confirms that lockdown itself should be disabled.

## Planner and evidence boundaries

Every ordinary turn reaches semantic planning. The first skill call declares the complete minimal skill set for the original request; the agent loop validates, canonicalizes, and freezes that scope. Later attempts to add or replace skills are rejected before execution and returned as deterministic corrective feedback. The executor repeats the scope check as defense in depth.

Malformed planner output is retried once. A second failure before any tool execution falls back to grounded core chat with no claim of external work. Once an observation exists, Shiva must continue from that evidence. A success response requires a `success=true` observation for every selected skill, and a failure response requires an actual failed observation. Runs remain bounded by `AGENT_MAX_STEPS` and `AGENT_REQUEST_TIMEOUT_MS`.

An identical same-run skill replay is suppressed using a canonical skill-and-arguments key. The original observation remains authoritative, which prevents repeated side effects and avoids hammering an unavailable integration.

## Audit boundary

PostgreSQL stores control-plane history, not an expense ledger:

- `agent_runs` records a constant redacted request marker, conversation/user IDs, status, step count, error code, and timing;
- `skill_runs` records the skill, effective execution mode, action mutability and impact, sanitized input/result, optional confirmation ID, status, error code, and timing;
- `action_confirmations` records exact action-bound approval state with sanitized arguments and a hash;
- `expense_sheet_bindings` records only Google spreadsheet/tab identifiers and provisioning coordination metadata.

Audit payloads are bounded and recursively redact credential-shaped fields, labeled inline secrets, credential-bearing URLs, private keys, JWTs, and common provider-token formats. Error codes and confirmation reasons pass through the same text sanitizer. Expense and repository-reading skill payloads remain fully redacted; workspace terminal audits retain bounded command arguments and safe denial diagnostics while successful output stays redacted. The workspace readers reject conventional environment, credential, token, password, and private-key files before content becomes model-visible. Runtime providers retain OAuth refresh tokens, authorization headers, AWS secret keys, and similar credentials instead of returning them to the planner. The ordinary conversation and memory path is separate, so the original user utterance may still exist as chat data and operators must not place live credentials in ordinary readable source files.

## External capability boundaries

Google OAuth credentials stay inside runtime providers. The recommended expense grant is offline access with `https://www.googleapis.com/auth/drive.file`; Shiva never needs the user's Google password. The legacy `EXPENSE_SHEET_ID` path uses Application Default Credentials and a sheet explicitly shared with that identity. PostgreSQL stores no Google token or expense row.

The Brave key remains server-side. Public-page fetching rejects URL credentials and local/private/reserved destinations after DNS resolution, rechecks redirects, and bounds content type, size, and time. Conversation text, pages, snippets, workspace files, and tool results are untrusted data and cannot approve an action, change execution mode, disable lockdown, or widen the frozen skill scope.

The current `workspace_terminal` capability is technically read-only in every execution mode. It exposes only bounded inspection commands and read-only Git subcommands, with no shell, stdin, redirection, interpreter, network program, package manager, or mutation operation. Direct reads and recursive `rg`/Git content searches share a case-insensitive deny policy for `.env*` other than `.env.example` and conventional credential, token, password, and private-key files or stores. Other repository content remains inspectable so Shiva can understand and evolve its own code. `FULL_ACCESS` cannot create a capability that the registered tool, operating system, or provider does not supply. If workspace mutation is added later, ordinary writes will follow the same global mode policy and genuinely sensitive operations will use one exact persisted confirmation.

## Current deployment boundary

Shiva still has no end-user authentication, role system, or multi-user authorization boundary. Execution modes are not authentication. The API and Python voice services bind to localhost by default and should be exposed only through a trusted private tunnel or authenticated reverse proxy.
