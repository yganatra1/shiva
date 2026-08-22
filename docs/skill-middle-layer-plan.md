# Shiva skill middle layer — implementation plan

## Status

**v2 — reviewed, direction approved, still pre-implementation.** Codex's execution-mode/confirmation migration (SAFE/AUTO/FULL_ACCESS) is functionally complete — as of 2026-08-22 it's fully staged in the working tree (`git status` shows every affected file staged) but **not yet committed to `main`**. This version folds in an external review pass (2026-08-22) that approved the pack-based approach and requested five specific changes, all incorporated below. Phase 0 (resync once that work is actually committed) is still the required first step before writing any of this.

This doc is the concrete engineering plan for turning `docs/skill-addition.md`'s "three levels" vision into working code, scaling from the 7 skills registered today toward the ~100-tool catalog in that doc, without dumping 100 tool schemas into every planner call.

## 1. The problem, precisely

`AgentLoop.run()` ([app/src/agent/agent-loop.ts](app/src/agent/agent-loop.ts)) already has a two-phase scoping mechanism: the first planner call is unscoped and sees every registered skill; once the planner issues a `skill_call`, its `selectedSkills` array is validated and frozen (`freezeSkillScope`), and every subsequent call in that run is restricted to that frozen set. **This freeze mechanism is already the right foundation and needs no redesign** — with one caveat noted in §8's open issues, added by the review.

The actual bottleneck is upstream of it: on that first, unscoped call, `allowedSkillSummaries()` returns `registry.list()` — literally every registered skill — and `buildPlannerPrompt()` in [app/src/agent/planner.ts](app/src/agent/planner.ts) prints one full block (name, description, configured flag, input contract, mutability/impact) per skill. At 7 skills that's cheap. At 100 skills, **every single turn — including plain conversational ones that end in `direct_chat`** — pays the token/latency cost of ~100 tool blocks just so the planner can decide it needs none of them. This is exactly what `docs/skill-addition.md` warns against ("I would not send 500 tool schemas to Gemma with every message").

So the real design question is narrow: *how does the planner pick an initial candidate set without first seeing full definitions for everything?*

The experience this must preserve, unchanged: **every installed skill is always available to Shiva from the user's perspective.** The user never selects a pack, enables "Gmail mode," or loads a connector. Packs exist only internally, to stop Gemma from receiving every tool definition on every message.

## 2. Design: pack-based two-hop planning

Add one grouping concept — a **pack** — between "skill" and "the whole registry." A pack is a named cluster of related skills (`email`, `calendar`, `terminal`, `docker`, ...) with one short static description, the same relationship `docs/skill-addition.md` calls "Level 1 catalog" vs "Level 2 tool definitions."

Mechanism:

1. Every `ShivaSkill` declares a `pack: string`, validated against a **runtime pack registry**, not a closed compile-time union (see §2.1 — this was a direct review correction to the original draft).
2. `SkillRegistry` gains `listPacks(): PackSummary[]`, grouping `list()` by `pack` (`{ name, description, skillCount, configured }`).
3. When no scope is established yet, the planner prompt shows the **complete pack catalog** — every pack, every time, unpaginated. At ~15-25 packs this is cheap enough that no search/discovery mechanism is needed to find the right one; the planner never has to guess at a pack it can't see.
4. A planner decision, tentatively `{"type":"open_packs","packs":["email","expenses"]}`, lets the planner narrow the candidate pool without yet committing to a specific skill (it can't name a specific skill it hasn't seen the definition of). This is a **prompting-only** narrowing step — it does not touch `freezeSkillScope`, `normalizeInitialSkillScope`, or anything execution/security-related.
5. `open_packs` is **additive, not a replacement**, and may be issued more than once before the first `skill_call`: `openPacks = union(openPacks ?? [], decision.packs)`. This is the review's second change — e.g. the planner opens `email` first, reads the available skills, realizes it also needs `google` (Drive) to save an attachment, and issues a second `open_packs` call to add it, all before any scope freezes. Once a real `skill_call` happens, today's existing freeze behavior takes over unchanged.
6. `AgentLoop` tracks a loop-local `openPacks` alongside the existing `selectedSkills`. Summary selection for the prompt becomes three-tiered:
   - `selectedSkills` frozen → exactly today's behavior (unchanged).
   - `openPacks` set, nothing frozen yet → skills within those packs only (Level 2 — full per-skill definitions, just for a narrow slice).
   - neither set → the full pack catalog (Level 1).
7. Once the planner issues a real `skill_call`, everything downstream — `freezeSkillScope`, the executor, the policy/execution-mode engine, audit — is **completely unchanged**. They already operate on concrete skill names and never knew packs existed.

Net effect: a plain chat turn only ever sees ~15-25 pack descriptions, never full tool schemas. A turn that genuinely needs a tool pays one or two extra fast local-Gemma round trips (each just a planning hop, no external call) to open the relevant pack(s), then proceeds exactly as today.

### 2.1 Pack registry, not a TypeScript union (review change #1)

The original draft proposed `type SkillPack = "gmail" | "calendar" | ...`. The review's objection: that bakes every future pack into a compile-time edit, which blocks the eventual goal of Shiva installing a new skill/connector (e.g. Spotify) and having its pack simply appear, rather than requiring a type edit + recompile + redeploy.

Instead: a small `PackRegistry` class mirroring `SkillRegistry`'s existing shape —

```ts
interface SkillPack { readonly name: string; readonly description: string; }

class PackRegistry {
  register(pack: SkillPack): void;   // validates name format + rejects duplicates
  has(name: string): boolean;
  list(): readonly SkillPack[];
}
```

`SkillRegistry` takes a `PackRegistry` as a constructor dependency and validates `skill.pack` against it in `validateDefinition`, the same place it already validates `execution.mutability`/`execution.impact`. For this phase the pack catalog is still just a static module (`app/src/skills/packs.ts`) that calls `packRegistry.register(...)` once per known pack at startup — nothing dynamic is being built yet — but the shape is a runtime registry from day one, so nothing structural has to change when dynamic installation eventually arrives.

### 2.2 Terminology (adopted from review)

Five concepts, kept strictly separate — none of them should bleed into another:

| Concept | Role |
| --- | --- |
| **Pack** | Discovery/context organization only. Zero authority over execution. |
| **Skill** | One user-facing capability (`email_send`, `record_expense`). |
| **Tool execution** | The runtime step that actually calls out. |
| **Execution mode** | The safety policy (SAFE/AUTO/FULL_ACCESS + sensitive-action confirmation) — entirely Codex's merged work, untouched by this plan. |
| **Connector** | The actual implementation reaching an external system (`GoogleConnector`, an `AndroidDeviceConnector`, `AWSConnector`) that a skill calls into to get real access. |

A pack is not a permission boundary and must never become one. Two skills in the same pack can have completely different execution metadata; two packs can share one connector (all six Google-surface skills use one OAuth connector regardless of which packs they're split across).

### 2.3 Why static pack pre-filter over semantic search

- *Static pack pre-filter* (chosen): deterministic, no new infrastructure, reuses the existing freeze machinery almost untouched, matches the "don't over-engineer" instruction repeated in both specs.
- *Embedding/semantic `search_skills`* (rejected for now, review confirms this explicitly): reuses the existing `EMBEDDING_MODEL`/pgvector infra used for memory, but adds an indexing pipeline and another failure mode for a catalog that's curated and ~100-tool/~30-50-skill sized, not open-ended. Revisit only once the catalog is heading toward hundreds of skills, downloadable MCP servers, or user-installed plugins — not before (see §6, Phase 5).

## 3. Concrete integration points

| File | Change |
| --- | --- |
| `app/src/skills/pack-registry.ts` *(new)* | `PackRegistry` class per §2.1 |
| `app/src/skills/packs.ts` *(new)* | Static seed of the ~15-25 packs (name + description) |
| `app/src/skills/types.ts` | Add `pack: string` to `ShivaSkill`/`RegisteredSkill`/`SkillSummary`; add `PackSummary` |
| `app/src/skills/registry.ts` | `SkillRegistry` takes a `PackRegistry` dependency; validate `skill.pack` in `validateDefinition`; add `listPacks()` |
| `app/src/agent/types.ts` | Add `open_packs` to `AgentDecision` (packs: string[]); thread pack summaries into `AgentPlanningContext` |
| `app/src/agent/planner.ts` | New decision schema branch + JSON-schema variant for `open_packs`; `buildPlannerPrompt` branches between pack-level and skill-level rendering |
| `app/src/agent/agent-loop.ts` | Track `openPacks` local state (union-merge on each `open_packs` decision, per §2 point 5); branch skill-summary selection three ways; update `describeCapabilities()` to summarize by pack |
| every `skills/<name>/skill.ts` | Add a `pack` field |
| `app/src/agent/runtime.ts` | Reorganize from one flat function into per-pack registration calls (see §5) |

## 4. Pack taxonomy — v2 (revised per review)

Review feedback: keep this coarser than the original draft — target 15-25 packs even once the catalog reaches hundreds of tools, not one pack per connector. Concretely: the original draft split Google into six packs (`gmail`, `calendar`, `contacts`, `drive`, `sheets`, `docs`); consolidated below to three, since `contacts`/`drive`/`sheets`/`docs` are each thin and low-frequency enough to share one `google` pack, while `email` and `calendar` stay separate as the two highest-frequency surfaces. The review also surfaced a concrete near-term connector this taxonomy needs to account for: **a planned Android companion app**, acting as a connector for phone-native capabilities (contacts, calls, notifications, clipboard, camera, location, battery) — surfaced here as `device` and `communication` packs.

- `core` — self-diagnostics, skill/tool discovery, universal search, conversation search (doc §1, 3, 49, 79)
- `memory` — explicit memory tools (`memory_search`, `memory_forget`, ...) *if/when* they become callable skills (doc §2). Today's automatic working-memory/long-term-retrieval context injection happens before the agent loop even runs and is **not** part of the skill/pack system at all — this pack only matters once/if explicit memory tools are exposed as skills.
- `web` — web/news/image/video search, browser automation, downloads (doc §4-5) — existing `web_research` lives here
- `email` — Gmail read/write/manage/intelligence (doc §8)
- `calendar` — calendar read/write, conflicts, free-time search (doc §9)
- `google` — contacts, Drive, Sheets (generic), Docs (doc §10, 15-18) — one OAuth connector shared with `email`/`calendar`
- `device` — Android phone/device actions: contacts, notifications, location, apps, clipboard, camera, battery/phone status — routes through the future `AndroidDeviceConnector`
- `communication` — WhatsApp, SMS, calling, possibly Slack/Teams later (doc §28-30) — may also route through the Android connector
- `expenses` / `finance` — merge into one `finance` pack: existing `record_expense`/`expense_report` plus personal finance, receipts/invoices (doc §17, 35-36) — expect most non-expense items here to default to `impact: sensitive`
- `documents` — generic office/PDF/OCR handling (doc §19-23)
- `productivity` — notes, tasks/todo, projects, personal inventory, warranty (doc §26-27, 37-38, 65)
- `automation` — automations, watchers, notifications, reminders, event bus, long-running jobs (doc §11-14, 84-85)
- `location_travel` — maps, travel, shopping, food (doc §31-34)
- `development` — git, GitHub, coding assistant (doc §39-41)
- `system` — terminal, process management, system info, GPU, logs, PostgreSQL, network diagnostics (doc §42-43, 46-48, 50, 54) — builds directly on the existing `workspace_terminal` skill
- `docker` — Docker + PM2 (doc §44-45) — kept separate from `system`; container/process restarts are a distinctly higher-risk, frequently-invoked-alone operation worth its own pack
- `cloud` — AWS, Azure, cloud cost (doc §57-59)
- `ai_ops` — model management, Ollama, provider routing, embeddings, knowledge base/RAG (doc §60-64)
- `backup` — backup/restore, storage abstraction, SSH to remote hosts (doc §51-53) — kept apart from `system` since it's the one place high-blast-radius operations concentrate
- `home` — smart-home devices, printing (doc §76, 78)
- `media` — Spotify/YouTube/local audio (doc §77)
- `daily_assistant` — daily briefing/review, meetings, translation, health/fitness info, news (doc §66-72)

21 packs. Within a pack, skills may be grouped into sub-areas for prompt readability once opened (e.g. `communication` showing WhatsApp/SMS/calling as visually distinct clusters) — that's a rendering nicety inside `buildPlannerPrompt`, not a new registry-validated hierarchy level; don't build a third tier under Pack → Skill.

## 5. Skill-authoring ergonomics at ~100 skills

Two structural changes so adding skill #50 isn't as much ceremony as skill #1:

- **`defineSkill()` helper** (or similarly named factory) wrapping `{ name, pack, description, inputDescription, inputSchema, execution, configured, execute }` into a `ShivaSkill` — cuts each new tool from a full class down to one object literal. Most of the ~100 tools are thin wrappers around one connector call (`email_search`, `email_send`, `calendar_create`, ...); today's per-skill class ceremony (see `RecordExpenseSkill`) is fine at 7 skills, repetitive at 100.
- **Per-pack registration modules**: `app/src/skills/<pack>/register.ts` exporting `registerXSkills(registry, config, deps)`, called from `runtime.ts`, which becomes an orchestrator instead of one growing function. Mirrors the existing conditional-registration pattern (`if (config.braveSearchApiKey) ... else ...`) already used for expenses/web-research — just split per pack instead of inlined in one function.
- **Connectors** (§2.2) are the shared credential/implementation modules multiple packs draw on: one Google OAuth token provider already exists (`GoogleUserOAuthAccessTokenProvider`) and should be reused by `email`/`calendar`/`google` rather than re-implemented per pack. The Android app, once it exists, becomes one `AndroidDeviceConnector` shared by `device` and `communication`. New connector modules (AWS SDK credentials, GitHub token, Docker/PM2 local exec reusing the existing `ReadOnlyWorkspaceTerminal`-style pattern) follow the same shape: one connector, one credential path, potentially several packs' worth of skills calling into it. Gemma never needs to know which connector answered a call.

## 6. Phased build sequence

**Phase 0 — Resync (blocking, do first).**
Pull Codex's merged execution-mode/confirmation work. Re-read `skills/types.ts`, `registry.ts`, `executor.ts`, `security/policy-engine.ts` (and the new `execution-mode.ts`/`execution-state.ts`/`confirmation.ts`) to confirm the final `execution` metadata shape and confirmation flow. Run the existing suite to confirm a green baseline before adding anything. Also re-check `docs/agent-architecture.md` at this point — see §8 item 1.

**Phase 1 — `PackRegistry` + `pack` as inert metadata.**
Build `PackRegistry` (§2.1), seed it with the packs the 7 existing skills need (`core`, `finance`, `web`, `system`, and whatever Codex's `execution_control`/lockdown skills ended up named), tag the existing skills. No planner/agent-loop behavior change yet — ships and tests in isolation, low risk, easy to revert if the taxonomy needs rework.

**Phase 2 — the two-hop mechanism itself (highest-value, highest-risk phase).**
Add `open_packs` (with union-merge semantics, §2 point 5), the pack-level prompt branch, `listPacks()`, the `openPacks` loop state, and the pack-aware `describeCapabilities()`. Ship and dogfood against the current 7 skills / handful of packs *before* adding any of the other ~90 catalog skills, so bugs in the mechanism surface against a small known-good set, not a freshly-built 100-skill catalog at the same time.

**Phase 3 — authoring scaffolding.**
`defineSkill()` helper, per-pack `register.ts` modules, `runtime.ts` becomes an orchestrator. No new user-facing skills yet — this phase just makes Phase 4 additions cheap and uniform.

**Phase 4 — build out the catalog, pack by pack.** Suggested order, cheapest/highest-value first:
1. `system` read paths, `docker` read paths — no new credentials needed
2. `email`, `calendar`, `google` — reuse the existing OAuth plumbing
3. `development`, `docker` write paths, `backup` — see the open decision in §8 before building any workspace-mutating skill
4. `device`, `communication` — once the Android companion app exists to act as their connector
5. `cloud` (AWS/Azure) — own credential plumbing, later
6. everything else — backlog, added opportunistically using the now-stable pattern

**Phase 5 — post-launch evaluation (not scheduled; revisit only if evidence emerges).**
Two independent open questions the review raised, deliberately deferred rather than designed now:

- **5a. Semantic skill discovery.** Only if pack-level granularity proves insufficient in real use. Start with plain keyword/substring match over skill names+descriptions as a `search_skills` meta-tool before reaching for embeddings — `EMBEDDING_MODEL`/pgvector infra already exists if keyword matching turns out inadequate.
- **5b. Frozen-scope limits legitimate mid-task discovery.** `freezeSkillScope` requires the planner to name the *complete* skill set on its first `skill_call`, before any tool has run — fine when the model can predict the chain upfront, but a real limitation for open-ended diagnostic asks (Codex's own AUTO-mode example: "check why Shiva API is failing and fix it" might start needing `docker`/`system` and only discover mid-diagnosis that `database` is the actual culprit). This is a limitation of the *existing* freeze mechanism, not something the pack layer introduces or can fix by itself. Explicitly not being redesigned alongside the execution-mode migration or this plan — flagged here so it isn't forgotten once real usage surfaces it.

## 7. Testing strategy

- Keep per-skill unit tests as today (pattern: `app/test/record-expense-skill.test.ts`).
- New `PackRegistry` tests: duplicate/invalid-name rejection, `list()`, mirroring `skill-registry.test.ts`'s existing style.
- Extend `app/test/skill-registry.test.ts` with pack invariants: every registered skill has a `pack` that exists in the injected `PackRegistry`.
- New `agent-loop` tests for the `open_packs` path, mirroring the existing `selectedSkills`-freeze tests in `app/test/cross-skill.test.ts`: cold call → `open_packs` → second `open_packs` unions in another pack → skills from both are visible → `skill_call` proceeds and freezes exactly as today.
- A **prompt-budget regression test**: assert the unscoped planner prompt stays under a fixed size threshold regardless of total registered-skill count. This is the test that actually protects the reason the middle layer exists — without it, a future skill addition could silently regress back to a full dump and nobody would notice until the context window did.
- Confirm all existing planner/agent-loop/skill tests stay green through Phase 2 with only fixture updates where a test currently hardcodes "all skills visible on the first call."

## 8. Open decisions to resolve before/while implementing

1. ~~Workspace self-mutation stricter than the generic model~~ — **resolved.** Codex's staged rewrite of [docs/agent-architecture.md](docs/agent-architecture.md) explicitly retires the old two-confirmation state machine: "A future update/delete terminal must declare truthful write/sensitive metadata and remain behind the centralized execution policy. Sensitive mutations use the same exact, persisted, expiring confirmation protocol as every other skill." So `development`/`docker` write paths (Phase 4 item 3) are ordinary skills with `execution: {mutability:"write", impact:"normal"|"sensitive"}` like anything else — no bespoke double-confirmation flow to build. Re-verify this line survived unchanged once the work is actually committed.
2. **Exact decision-type name** (`open_packs` vs `select_skill_group` vs something else) and whether each `open_packs` hop consumes one of the run's `maxSteps` budget (recommendation: yes, keep the loop's existing step accounting simple; each hop is a local-model-only round trip with no external call, and the default 8-32 budget has headroom for 2-3 of them before real execution starts).
3. ~~Pack taxonomy sign-off~~ — resolved by the §4 v2 revision above. Still worth a final pass once Phase 0 lands and the Android app's actual capability list is known.

## 9. Explicit non-goals

- No per-tool permission strings, no policy DSL — packs are a prompt-shaping convenience only, never consulted by the executor, policy engine, or audit layer. The security boundary stays exactly where Codex's execution-mode work put it (mode + mutability/impact), unchanged by anything in this document.
- No dynamic/hot-reloadable skill installation in this phase. `PackRegistry` being a runtime registry (§2.1) makes that possible later without a rewrite, but no installer flow is being built now.
- No embedding/vector-based skill search unless §6 Phase 5a's trigger condition is actually observed.
- No redesign of `freezeSkillScope` — §6 Phase 5b is an evaluation flag, not a scheduled change.

## 10. After this plan

Once this mechanism is implemented and stable (through Phase 3), the next deliverable — explicitly not this document — is a proper **master Skills + Connectors + Android capabilities list**, replacing `docs/skill-addition.md`'s ~90-section brainstorm as the actual Shiva roadmap. That's scoped as a follow-up collaborative pass, not something to build unilaterally ahead of the mechanism it depends on.
