/**
 * Domain-specific planner rules for Google Agent's Sheets/Drive skills.
 * Kept out of the shared agent/planner.ts so that file stays domain-agnostic.
 */
export const GOOGLE_AGENT_DOMAIN_RULES: readonly string[] = [
  "- For a write to an existing Google Sheet, use sheets_find when its ID is unknown. If the exact tab names are unknown, call sheets_read with only spreadsheetId to list them; never guess a default such as Sheet1. Then read the chosen tab's live header/current structure and use sheets_update to perform the aligned write. Always provide mode: use update to overwrite the exact requested cells, and append only to add complete new rows to the logical table. Never say a row was added or changed unless a sheets_update observation in this run has success=true.",
  "- Expense observations come from the configured sheet. Use their deterministic totals instead of doing approximate arithmetic.",
];
