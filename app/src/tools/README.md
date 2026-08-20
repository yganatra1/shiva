# Tool boundaries

Tools are narrow adapters used by registered Shiva skills. The planner never calls an external service directly:

```text
planner decision
      |
      v
skill registry -> permission policy -> validated skill
                                      |
                                      v
                                primitive tool
                                      |
                                      v
                         external source or action
```

The intent router derives an allowed-and-required skill set from the original user request. The planner sees only those contracts. If it selects anything outside that scope, the agent loop terminates with `AGENT_INVALID_RESPONSE` before the `SkillExecutor` or tool runs; the executor independently retains the scope check as defense in depth. The executor then checks permissions and validated input before an allowed tool runs. A tool returns structured data to the skill; that result becomes an observation for the next bounded agent step. External errors are converted to safe failures and must never be presented as successful actions. The agent loop accepts a success response only when every required skill has successful tool evidence; one failed required-skill observation is enough for a safe early failure response in a dependent chain. All planner and tool steps share the single `AGENT_REQUEST_TIMEOUT_MS` run deadline; it does not restart for each external call, and expiry becomes the safe `AGENT_TIMEOUT` response.

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

`expense.list` reads the same live A:G range, validates every non-empty row, applies inclusive `from` and exclusive `until` filters, and sorts newest first. `expense_report` calculates totals and `matchedCount` across every matched row with integer minor units, then limits individual planner-visible details to 1–25 requested rows (default 25) and at most 8,000 serialized characters. The detail list stops before either bound is exceeded. Currencies remain separate, so it does not introduce floating-point drift or invent exchange rates.

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

Web pages, snippets, conversation text, and tool results are untrusted data. They cannot grant permissions, expand the request's allowed skills, trigger an expense write, or introduce a new objective. A write skill is in scope only when the original user request explicitly contains that write intent.

This is a restricted document reader, not a browser. It does not run JavaScript, submit forms, maintain login sessions, download arbitrary binary files, or bypass access controls. DNS validation substantially reduces SSRF exposure but is not a substitute for network-level egress controls in a hostile multi-tenant deployment.

## Verification boundary

Unit and cross-skill tests inject fake binding stores, repositories, OAuth/access-token responses, Sheets responses, search responses, page fetches, DNS results, and planners. They require no Google, Brave, Ollama, or GPU access and do not prove those live services are configured correctly. A deployment must separately verify OAuth consent/refresh-token lifetime, autonomous sheet creation (or legacy sharing/header shape), outbound network access, and upstream service availability.
