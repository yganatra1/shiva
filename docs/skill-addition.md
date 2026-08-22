Yes. Let’s lock the design before touching the code.

For **Shiva V0.3**, I suggest we deliberately keep the first version small:

> **One orchestrator + one execution engine + two real skills.**

The two initial skills should be:

1. **`web_research`** — proves Shiva can go outside its own knowledge, perform multiple steps, observe results, and answer from evidence.
2. **`record_expense`** — proves Shiva can take an actual action that changes persistent data.

Later, `record_expense` can switch from PostgreSQL to your Google Sheet without changing how Shiva thinks.

---

# Shiva V0.3 Architecture

```text
                           YOU
                            │
                            ▼
                    ┌──────────────┐
                    │  Shiva API   │
                    │    /chat     │
                    └──────┬───────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Shiva Orchestrator  │
                │                     │
                │ Gemma = Brain       │
                └─────────┬───────────┘
                          │
                  decides what to do
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
      RESPOND          USE SKILL       CONTINUE PLAN
                          │
                          ▼
                 ┌──────────────────┐
                 │  Skill Registry  │
                 └────────┬─────────┘
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
      web_research              record_expense
             │                         │
             ▼                         ▼
       Web Tools                  DB Tools
             │                         │
             ▼                         ▼
        Internet                 PostgreSQL
```

The important part is the loop:

```text
Understand
   ↓
Decide
   ↓
Execute
   ↓
Observe result
   ↓
Decide again
   ↓
Execute another action if necessary
   ↓
Final response
```

That is the beginning of Shiva behaving like an **agent**, rather than just an LLM wrapper.

---

# 1. Keep Tools and Skills Separate

I'd introduce both concepts now.

### Tool

Very small primitive operation.

Examples:

```text
web.search
web.open
expense.insert
expense.list
```

### Skill

Something Shiva understands conceptually.

```text
web_research
record_expense
```

For example:

```text
web_research
     │
     ├── web.search
     ├── web.open
     ├── web.open
     └── synthesize findings
```

Whereas:

```text
record_expense
     │
     └── expense.insert
```

Eventually:

```text
record_expense
     │
     ├── memory.get_expense_sheet
     ├── google.sheets.append_row
     └── google.sheets.read_row
```

Gemma doesn't need to care about that implementation change.

---

# 2. Proposed Folder Structure

Inside the existing Shiva API:

```text
src/
│
├── agent/
│   ├── orchestrator.ts
│   ├── agent-loop.ts
│   ├── planner.ts
│   ├── agent-context.ts
│   └── types.ts
│
├── skills/
│   ├── registry.ts
│   ├── types.ts
│   │
│   ├── web-research/
│   │   ├── skill.ts
│   │   ├── prompt.ts
│   │   └── types.ts
│   │
│   └── record-expense/
│       ├── skill.ts
│       └── types.ts
│
├── tools/
│   ├── registry.ts
│   ├── types.ts
│   │
│   ├── web/
│   │   ├── search.ts
│   │   └── open.ts
│   │
│   └── expenses/
│       ├── insert.ts
│       └── list.ts
│
├── security/
│   ├── execution-mode.ts
│   └── policy-engine.ts
│
├── memory/
│   └── ...
│
└── services/
    └── shiva-chat.service.ts
```

This gives us room to grow without rebuilding everything later.

---

# 3. Standard Skill Interface

Every future skill follows the same contract.

```ts
export interface ShivaSkill<TInput = unknown, TOutput = unknown> {
  name: string;

  description: string;

  inputSchema: z.ZodType<TInput>;

  execution: {
    mutability: "read" | "write";
    impact: "normal" | "sensitive";
  };

  execute(
    input: TInput,
    context: SkillContext
  ): Promise<SkillResult<TOutput>>;
}
```

Example:

```ts
const recordExpenseSkill = {
  name: "record_expense",

  description:
    "Records a personal expense when the user says they spent, paid, bought or wants to note an expense.",

  execution: { mutability: "write", impact: "normal" },

  inputSchema: z.object({
    amount: z.number().positive(),
    description: z.string(),
    category: z.string().optional(),
    occurredAt: z.string().optional()
  }),

  execute: async (input, ctx) => {
    // actually insert expense
  }
};
```

Then:

```ts
skillRegistry.register(recordExpenseSkill);
skillRegistry.register(webResearchSkill);
```

Later we just keep adding:

```ts
skillRegistry.register(sendEmailSkill);
skillRegistry.register(calendarSkill);
skillRegistry.register(expenseReportSkill);
skillRegistry.register(runBackupSkill);
```

---

# 4. Skill #1 — `record_expense`

Let's make this a **real executing skill**, not a fake test.

Add an `expenses` table.

Something roughly like:

```text
expenses

id
user_id
amount
currency
description
category
occurred_at
metadata
created_at
updated_at
```

Example interaction:

> Shiva, add ₹450 for pizza tonight.

Gemma should produce an action approximately equivalent to:

```json
{
  "action": "execute_skill",
  "skill": "record_expense",
  "arguments": {
    "amount": 450,
    "currency": "INR",
    "description": "Pizza",
    "category": "Food"
  }
}
```

Executor runs it.

PostgreSQL gets:

```text
₹450
Pizza
Food
20 Aug 2026
```

Tool result:

```json
{
  "success": true,
  "expenseId": "...",
  "amount": 450
}
```

That result goes **back into Gemma**.

Then Shiva says:

> Added ₹450 for pizza to your expenses.

It does not say it succeeded until the executor actually returns success.

That's important.

---

# 5. And Give It Expense Reading Too

Even though `record_expense` is the main skill, I would also expose an expense reading tool immediately.

Therefore you can test:

> “Add ₹450 pizza.”

Then:

> “What did I spend today?”

Shiva can call:

```text
expense.list
```

and calculate from actual database contents.

That's already going to make Shiva feel much more alive.

---

# 6. Skill #2 — `web_research`

This one is more interesting because it should itself be agentic.

You ask:

> Shiva, find which local TTS models currently work best for Indian English.

Instead of Gemma answering from training knowledge:

```text
Shiva
 ↓
web_research
 ↓
generate searches
 ↓
search internet
 ↓
inspect results
 ↓
open selected pages
 ↓
extract information
 ↓
possibly search again
 ↓
compare
 ↓
return research package
 ↓
Gemma answers
```

The returned result could contain:

```json
{
  "query": "...",
  "sources": [
    {
      "title": "...",
      "url": "...",
      "content": "..."
    }
  ],
  "findings": [...]
}
```

Then the brain writes the response using those findings.

---

# 7. Don't Depend on Native Gemma Tool Calling

This is one architectural choice I'd make from the beginning.

Even if a particular model supports native function/tool calls, **Shiva shouldn't depend on it**.

Have the brain produce a standardized Shiva decision format.

For example:

```json
{
  "type": "skill_call",
  "skill": "record_expense",
  "arguments": {
    "amount": 1250,
    "description": "Dinner"
  }
}
```

or:

```json
{
  "type": "respond",
  "message": "..."
}
```

or:

```json
{
  "type": "skill_call",
  "skill": "web_research",
  "arguments": {
    "query": "latest ..."
  }
}
```

Validate all of it with Zod.

Therefore tomorrow you can replace:

**Gemma → Qwen → GLM → GPT → whatever**

and Shiva's execution architecture remains unchanged.

---

# 8. The Agent Loop

This is the core.

Something conceptually like:

```ts
const MAX_AGENT_STEPS = 8;

for (let step = 0; step < MAX_AGENT_STEPS; step++) {

  const decision = await planner.decide(context);

  if (decision.type === "respond") {
    return decision.message;
  }

  if (decision.type === "skill_call") {

    const result = await skillExecutor.execute(
      decision.skill,
      decision.arguments,
      context
    );

    context.addObservation({
      skill: decision.skill,
      result
    });

    continue;
  }
}

throw new AgentMaxStepsError();
```

Now Shiva can do this:

```text
You:
Research RTX 3090 vs 4090 and save the conclusion.

Agent iteration #1
→ web_research

Observation
→ research results

Agent iteration #2
→ memory/save skill

Observation
→ saved successfully

Agent iteration #3
→ respond
```

That's actual autonomous multi-step execution.

---

# 9. Don't Create Separate Agents Yet

This distinction matters.

I don't want us immediately building:

```text
ResearchAgent
ExpenseAgent
GoogleAgent
TravelAgent
EmailAgent
WeatherAgent
CalendarAgent
...
```

That will get messy very quickly.

Instead:

```text
                Shiva
             Orchestrator
                  │
       ┌──────────┼─────────┐
       ↓          ↓         ↓
    Skills      Skills    Skills
```

Then a **complex skill can internally become an agent** later.

For example:

```text
plan_trip
```

could eventually instantiate:

```text
Travel Agent
├─ web research
├─ flights
├─ hotels
├─ weather
└─ visa
```

But Shiva itself stays the master orchestrator.

That gives you the "manage agents internally" architecture you're looking for without overengineering V0.3.

---

# 10. Execution Policy Starts Now

Each skill declares only lightweight action metadata:

```ts
execution: { mutability: "write", impact: "normal" }
```

The centralized executor combines that classification with Shiva's persisted
`SAFE`, `AUTO`, or `FULL_ACCESS` mode before calling the skill. Normal explicit
actions run without repetitive prompts in `AUTO` and `FULL_ACCESS`; writes ask
in `SAFE`; sensitive actions always create an exact, expiring confirmation.
The runtime owns this decision, not Gemma.

Provider scopes, service credentials, operating-system permissions, and the
available tool adapters remain the real capability boundary. Shiva does not
duplicate those systems with granular permission keys.

---

# 11. Add an Execution Audit Table

I consider this important enough to build in V0.3.

Something like:

```text
agent_runs
```

and:

```text
skill_runs
```

For every action store:

```text
conversation
user
skill
sanitized input
execution mode and action classification
confirmation id, when required
result
success/failure
started_at
finished_at
duration
```

So later if Shiva does something unexpected, we can see:

```text
19:51:02 user request
19:51:03 Gemma chose record_expense
19:51:03 amount=1250
19:51:03 AUTO normal write allowed
19:51:04 DB INSERT success
19:51:05 response returned
```

This will become invaluable when Gmail and system access arrive.

---

# 12. What Our First Working V0.3 Should Be Able to Do

I would consider Phase 1 successful when all of these work naturally:

> **“Add ₹350 coffee to my expenses.”**

Shiva actually writes it.

> **“What expenses have I recorded today?”**

Shiva reads actual data.

> **“Research the latest good local TTS options for Shiva.”**

Shiva actually searches the internet.

> **“Research whether X is better than Y and recommend one.”**

Shiva searches multiple sources and compares them.

And importantly:

> **“Search for the latest RTX 3090 pricing and save ₹45/hour as my Shiva GPU cost.”**

Eventually that single instruction should cause **multiple actions**.

That's the behavior we're aiming for.

---

# Then Google Comes Next

Once these two prove the architecture, we don't redesign anything.

We just install new tools:

```text
google.gmail.search
google.gmail.read
google.gmail.draft
google.gmail.send

google.sheets.read
google.sheets.append
google.sheets.update

google.calendar.search
google.calendar.create
google.calendar.update
```

Then redefine:

```text
record_expense
```

from:

```text
PostgreSQL
```

to:

```text
Google Sheets
```

Or even let your preferences say:

```text
default expense destination:
Google Sheet → Personal Expenses → Expenses tab
```

Then:

> **“Shiva, note ₹1,250 dinner in my expense sheet.”**

becomes:

**Gemma understands → selects `record_expense` → skill resolves your expense sheet → Sheets tool writes row → tool verifies → Shiva confirms.**

Exactly what you want.

---

## So I would lock V0.3 Phase 1 as

**Brain:** existing Gemma
**Agent:** Shiva Orchestrator
**Execution:** Skill Executor
**Skill 1:** `web_research`
**Skill 2:** `record_expense`
**Primitive tools:** `web.search`, `web.open`, `expense.insert`, `expense.list`
**Security:** global execution mode + action classification
**Safety:** Zod validation + max agent steps
**Observability:** `agent_runs` + `skill_runs`
**Persistence:** PostgreSQL
**Future:** Gmail / Sheets / Calendar plug into exactly the same runtime.

And after we get these working, I would **immediately test cross-skill execution**. That's the real milestone where Shiva starts feeling alive:

> **“Research today's RTX 3090 rental pricing and record the cheapest price as a Shiva infrastructure expense.”**

If Shiva can independently **research → observe → reason → execute a second skill → verify → answer**, then our agent foundation is genuinely working.
