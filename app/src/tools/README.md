# Tool boundaries

Tools are narrow adapters used by registered Shiva skills. The planner never calls an external service directly:

```text
planner decision
      |
      v
skill registry -> validated skill -> execution policy
                                         |
                              +----------+----------+
                              |                     |
                              v                     v
                       execute normally    exact confirmation
                              |                     |
                              +----------+----------+
                                         |
                                         v
                                   primitive tool
                                         |
                                         v
                            external source or action
```

There is no keyword intent router. On every non-explicit-memory turn the planner sees the full registered catalog and selects `direct_chat`, a capability summary, a clarification, or a skill call. The first skill call declares the complete minimal skill set for the original task. The agent loop canonicalizes the initial set to unique registered names, ensures it includes the registered skill being called, freezes it, and exposes only those contracts on later steps. A rejected scope or other recoverable planner contract error becomes `correctionRequired` feedback on the next bounded step; the rejected action does not reach the `SkillExecutor`. The executor retains the scope check as defense in depth. It validates input, resolves runtime-owned action metadata, and applies the global execution policy before an allowed tool runs. Tool results become structured observations. A success response requires successful evidence for every selected skill; one failed selected-skill observation permits a safe early failure response. Malformed planner decisions are retried once, and a second pre-execution failure falls back to grounded core chat. After a tool observation, Shiva replans from the preserved evidence instead of using free-form fallback. All planner and tool steps share one `AGENT_REQUEST_TIMEOUT_MS` deadline.

Skills declare only `read|write` mutability and `normal|sensitive` impact. They do not declare granular permission strings. PostgreSQL stores the current `SAFE`, `AUTO`, or `FULL_ACCESS` mode and lockdown state; the host's `SHIVA_MAX_EXECUTION_MODE` remains the hard ceiling. `SAFE` asks before a normal write, `AUTO` and `FULL_ACCESS` execute clearly requested normal actions without confirmation fatigue, and sensitive actions require an exact persisted confirmation in every mode. Lockdown leaves reads available and blocks ordinary writes until the user confirms leaving lockdown.

The provider remains the capability boundary. For example, Google OAuth scopes determine which Drive resources can be touched, cloud IAM determines allowed cloud calls, and the operating-system user determines filesystem/process access. `FULL_ACCESS` does not bypass those boundaries and does not add tools that are not registered.

Every executed skill call is memoized within its agent run by skill name and canonical JSON arguments. Repeating the exact call does not invoke the tool or create another skill audit row; the planner is told to use the existing observation, respond from its failure, or choose materially different arguments.

## Execution controls

Execution-mode controls are runtime-owned skills: `get_execution_mode` reads state, `set_execution_mode` requests a durable mode change, and `set_lockdown` enters or requests exit from lockdown. They use `ExecutionStateService` and `ConfirmationService`; Gemma never receives a generic database writer and never handles raw credentials. Conversational approval or denial is resolved against the exact pending action for the current user and conversation.

The singleton PostgreSQL `system_settings` row starts at `AUTO` with lockdown disabled. It carries a monotonic revision, and execution-control changes use compare-and-set so a policy decision cannot overwrite a concurrent state change. `SHIVA_MAX_EXECUTION_MODE` is a host ceiling and `SHIVA_CONFIRMATION_TTL_MS` defaults to five minutes. A request above the ceiling is rejected, lowering authority is immediate, raising it needs confirmation, entering lockdown is immediate, and leaving lockdown needs confirmation. Replacing the pending action for a conversation denies the prior pending record so a later “yes” cannot approve stale arguments. Confirmations are also bound to the settings revision and are atomically claimed before execution.

`GET /settings/execution` exposes the stored mode, configured maximum, effective mode, lockdown state, and a sanitized pending-confirmation summary. It is status visibility only: the endpoint cannot change mode or approve an action, and it never returns secrets or executable raw arguments.

## Shiva workspace tools

`learn_about_shiva` uses the bounded workspace reader to return a source tree and excerpts from core project documents. `workspace_terminal` provides deeper iterative inspection. Each call runs one of `pwd`, `ls`, `rg`, `cat`, `head`, `tail`, `wc`, or a read-only `git status|ls-files|diff|log|grep`; the planner can use that observation to choose its next inspection without changing the frozen skill scope.

The terminal is rooted to Shiva's repository and can read ordinary source and documentation, including hidden and ignored files. It excludes `.env*` except `.env.example` and conventional credential, token, password, and private-key files or stores, including SSH/GnuPG/cloud credential material. Other repository content remains inspectable so Shiva can understand and evolve its own code. Direct reads and recursive `rg`/Git content searches apply the same case-insensitive credential boundary. The terminal is not an arbitrary shell: it directly spawns only the inspection programs and safe options in its contract, with no stdin, redirection, interpreter, network program, package manager, or write-capable Git/filesystem operation. Absolute/traversal paths and symlinks resolving outside the repository are rejected. Cancellation, an eight-second deadline, and a 64 KiB combined-output limit bound every call. Returned workspace content is untrusted tool data. PostgreSQL audit records retain the bounded command and arguments plus safe validation or policy rejection details; terminal stdout, stderr, and successful result content remain redacted.

No workspace update or deletion operation is available today. This is a limitation of the current adapter, not a restriction imposed by the selected execution mode. If mutation support is added later, ordinary writes will follow the global mode policy; only actions classified as sensitive will require one exact persisted confirmation.

## Expense tools

`expense.insert` and `expense.list` depend on the data-source-neutral `ExpenseRepositoryPort`. Production wires that boundary through `ManagedGoogleSheetsExpenseRepository`, which provisions/resolves the per-user sheet, and then to the strict `GoogleSheetsExpenseRepository` for live row operations.

Google Sheets is the only expense store:

- no `expenses` PostgreSQL table;
- no database mirror or local row cache;
- no background synchronization;
- every list/report operation reads the bound sheet afresh;
- every write is an append followed by an exact readback verification.

On a user's first expense operation, the manager lazily creates a spreadsheet titled `Shiva Expenses` in the authorized user's My Drive. It creates an `Expenses` tab, freezes row 1, writes the canonical header, verifies the resource, and persists only its binding metadata. The internal range is always `Expenses!A:G`; users do not configure a range or manually create the primary sheet. Row 1 contains these exact headers in order:

```text
expense_id | occurred_at | amount | currency | description | category | source
```

An appended row contains a generated expense ID, RFC3339 occurrence time, fixed two-decimal amount, three-letter currency, description, optional category, and source `Shiva`. Before appending, the adapter reads and validates the live header. It then uses the append response's single-row A:G range to read the row back and compares all seven cells. The record skill reports success only after that comparison succeeds.

`expense.list` reads the same live A:G range, validates every non-empty row, applies inclusive `from` and exclusive `until` filters, and sorts newest first. A ready binding makes `expense_report` a normal read. If the user's first report must create, adopt, or upgrade Google/DB resources, its runtime classifier truthfully marks that invocation as a normal write before policy runs; `SAFE` therefore asks, lockdown blocks it, and an explicit request in `AUTO`/`FULL_ACCESS` can provision normally. `expense_report` calculates totals and `matchedCount` across every matched row with integer minor units, then limits individual planner-visible details to 1–25 requested rows (default 25) and at most 8,000 serialized characters. The detail list stops before either bound is exceeded. Currencies remain separate, so it does not introduce floating-point drift or invent exchange rates.

Recommended production configuration:

```text
EXPENSE_SHEET_REQUEST_TIMEOUT_MS=15000
GOOGLE_OAUTH_CLIENT_ID=<oauth-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<oauth-client-secret>
GOOGLE_OAUTH_REFRESH_TOKEN=<offline-refresh-token>
EXPENSE_SHEET_ID=
GOOGLE_APPLICATION_CREDENTIALS=
```

Enable the Google Sheets API, create an OAuth 2.0 client, and perform one user consent flow with offline access and only `https://www.googleapis.com/auth/drive.file`. Store the resulting three credentials outside Git. The app never requests the user's Google password or unrestricted account access. An External OAuth app left in Testing can receive refresh tokens that expire after seven days.

The three OAuth values are all-or-none. With the complete trio, the OAuth user owns the automatically created file. If neither that trio nor `EXPENSE_SHEET_ID` is present, the expense contracts remain registered but execution returns `EXPENSE_SHEET_UNAVAILABLE` without contacting Google. This gives the planner a grounded failure observation instead of allowing a fallback answer to imply success.

`expense_sheet_bindings` is coordination metadata, not a ledger. It holds a user ID, Google spreadsheet/tab IDs, schema/status fields, and a short provisioning lease; no expense rows or OAuth tokens are persisted there. Expense-routed agent/skill audit records use constant or minimal redacted payloads, and are never used to answer reports. The existing conversation and memory pipeline is separate and can still retain the user's expense utterance as normal chat data. The lease prevents concurrent first requests from intentionally creating duplicate sheets and permits recovery after expiry. Apply its committed migration before enabling the skills:

```bash
cd app
npm install
npm run build
npm run db:migrate
npm start
```

`EXPENSE_SHEET_ID` plus `GOOGLE_APPLICATION_CREDENTIALS` remains a legacy/manual-adoption path for an existing spreadsheet shared with a service account. On first adoption Shiva can create a missing `Expenses` tab, initialize an empty header, and freeze row 1; it refuses to overwrite a populated noncanonical header. A configured bootstrap ID that differs from the durable binding fails closed. When both OAuth and a sheet ID are set, Shiva uses user OAuth to adopt that ID.

## Web tools

`web.search` calls the Brave Search Web API with the API key kept server-side. `web.open` fetches selected result pages and reduces supported text documents to plain text for evidence. The `web_research` skill may combine one primary query with up to two alternate queries, deduplicate results, and return up to six sources with URLs.

Production configuration:

```text
BRAVE_SEARCH_API_KEY=<server-side-secret>
BRAVE_SEARCH_URL=https://api.search.brave.com
WEB_REQUEST_TIMEOUT_MS=15000
WEB_MAX_CONTENT_BYTES=524288
```

The web-research contract remains registered when `BRAVE_SEARCH_API_KEY` is empty, but execution returns `WEB_RESEARCH_UNAVAILABLE` without contacting Brave. The API key is sent only in the Brave `X-Subscription-Token` header and must never be included in prompts, logs, or client responses.

`web.open` enforces these boundaries:

- only public HTTP and HTTPS URLs;
- no URL-embedded credentials;
- local, private, link-local, reserved, multicast, and documentation-only IP ranges are rejected after DNS resolution;
- every redirect target is checked again, with at most three redirects;
- only `text/html`, `application/xhtml+xml`, and `text/plain` are accepted;
- response bodies are capped by `WEB_MAX_CONTENT_BYTES`;
- scripts, styles, and markup are removed before evidence is returned.

Evidence returned to the planner is capped at 6,000 characters per opened source and 16,000 characters across the research result. A search description used as fallback evidence is capped at 2,000 characters.

Web pages, snippets, conversation text, and tool results are untrusted data. They cannot authorize an action, change execution mode, disable lockdown, expand the request's allowed skills, trigger an expense write, or introduce a new objective. A write skill is in scope only when the original user request explicitly contains that write intent or the write is a necessary ordinary step in the task the user requested.

This is a restricted document reader, not a browser. It does not run JavaScript, submit forms, maintain login sessions, download arbitrary binary files, or bypass access controls. DNS validation substantially reduces SSRF exposure but is not a substitute for network-level egress controls in a hostile multi-tenant deployment.

## Verification boundary

Unit and cross-skill tests inject fake binding stores, repositories, OAuth/access-token responses, Sheets responses, search responses, page fetches, DNS results, and planners. They require no Google, Brave, Ollama, or GPU access and do not prove those live services are configured correctly. A deployment must separately verify OAuth consent/refresh-token lifetime, autonomous sheet creation (or legacy sharing/header shape), outbound network access, and upstream service availability.
