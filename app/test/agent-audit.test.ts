import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { AgentLoop } from "../src/agent/agent-loop.js";
import type {
  AgentAuditPort,
  FinishAgentRunInput,
  FinishSkillRunInput,
  StartAgentRunInput,
  StartSkillRunInput,
} from "../src/agent/audit.js";
import type { AgentPlanner, AgentRequest } from "../src/agent/types.js";
import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { SkillRegistry } from "../src/skills/registry.js";

class RecordingAudit implements AgentAuditPort {
  readonly agentStarts: StartAgentRunInput[] = [];
  readonly agentFinishes: FinishAgentRunInput[] = [];
  readonly skillStarts: StartSkillRunInput[] = [];
  readonly skillFinishes: FinishSkillRunInput[] = [];

  async startAgentRun(input: StartAgentRunInput) {
    this.agentStarts.push(input);
  }
  async finishAgentRun(input: FinishAgentRunInput) {
    this.agentFinishes.push(input);
  }
  async startSkillRun(input: StartSkillRunInput) {
    this.skillStarts.push(input);
  }
  async finishSkillRun(input: FinishSkillRunInput) {
    this.skillFinishes.push(input);
  }
}

const request: AgentRequest = {
  userMessage: "Record an expense.",
  conversationId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  contextMessages: [],
};

test("agent and skill success are auditable around actual execution", async () => {
  const events: string[] = [];
  const audit = new RecordingAudit();
  audit.startSkillRun = async (input) => {
    events.push("audit-start");
    audit.skillStarts.push(input);
  };
  audit.finishSkillRun = async (input) => {
    events.push("audit-finish");
    audit.skillFinishes.push(input);
  };
  const registry = new SkillRegistry();
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number() }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      events.push("execute");
      return { success: true, data: { expenseId: "expense-1" } };
    },
  });
  let decision = 0;
  const planner: AgentPlanner = {
    async decide() {
      decision += 1;
      return decision === 1
        ? {
            type: "skill_call" as const,
            skill: "record_expense",
            selectedSkills: ["record_expense"],
            arguments: { amount: 10 },
            authorization: "user_authorized" as const,
          }
        : {
            type: "respond" as const,
            outcome: "success" as const,
            message: "Recorded.",
          };
    },
  };
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    audit,
    () => "40000000-0000-4000-8000-000000000004",
    () => 10,
  );
  const loop = new AgentLoop(
    planner,
    executor,
    registry,
    8,
    () => new Date("2026-08-20T00:00:00Z"),
    () => "30000000-0000-4000-8000-000000000003",
    audit,
    () => 20,
  );

  await loop.run(request);

  assert.deepEqual(events, ["audit-start", "execute", "audit-finish"]);
  assert.equal(audit.agentStarts.length, 1);
  assert.equal(audit.agentFinishes[0]?.status, "succeeded");
  assert.equal(audit.agentFinishes[0]?.stepCount, 2);
  assert.equal(audit.skillStarts[0]?.skill, "record_expense");
  assert.equal(audit.skillStarts[0]?.executionMode, "AUTO");
  assert.equal(audit.skillStarts[0]?.mutability, "write");
  assert.equal(audit.skillStarts[0]?.impact, "normal");
  assert.equal(audit.skillStarts[0]?.confirmationId, null);
  assert.equal(audit.skillFinishes[0]?.status, "succeeded");
});

test("expense agent and skill audit payloads are redacted without changing observations", async () => {
  const audit = new RecordingAudit();
  const registry = new SkillRegistry();
  const privateRecordInput = {
    amount: 987_654,
    description: "SECRET_DINNER_DESCRIPTION",
  };
  const privateRecordResult = {
    expenseId: "PRIVATE_SHEET_ROW_ID",
    ...privateRecordInput,
  };
  const privateReportInput = {
    from: "2042-01-PRIVATE_FROM",
    to: "2042-02-PRIVATE_TO",
  };
  const privateReportResult = {
    totals: { INR: 987_654 },
    rows: [{ id: "PRIVATE_REPORT_ROW_ID", note: "SECRET_SHEET_ROW" }],
  };

  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number, "description": string }',
    inputSchema: z
      .object({ amount: z.number(), description: z.string() })
      .strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      return { success: true, data: privateRecordResult };
    },
  });
  registry.register({
    name: "expense_report",
    description: "Reads an expense report.",
    inputDescription: '{ "from": string, "to": string }',
    inputSchema: z.object({ from: z.string(), to: z.string() }).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return { success: true, data: privateReportResult };
    },
  });

  const decisions = [
    {
      type: "skill_call" as const,
      skill: "record_expense",
      selectedSkills: ["expense_report", "record_expense"],
      arguments: privateRecordInput,
      authorization: "user_authorized" as const,
    },
    {
      type: "skill_call" as const,
      skill: "expense_report",
      selectedSkills: ["expense_report", "record_expense"],
      arguments: privateReportInput,
      authorization: "user_authorized" as const,
    },
    {
      type: "respond" as const,
      outcome: "success" as const,
      message: "Recorded SECRET_DINNER_DESCRIPTION; total is 987654.",
    },
  ];
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    audit,
  );
  const loop = new AgentLoop(
    {
      async decide() {
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    executor,
    registry,
    8,
    undefined,
    undefined,
    audit,
  );

  const result = await loop.run({
    ...request,
    userMessage:
      "Record 987654 for SECRET_DINNER_DESCRIPTION, then report 2042 private rows.",
    allowedSkills: ["record_expense", "expense_report"],
  });

  assert.equal(
    result.response,
    "Recorded SECRET_DINNER_DESCRIPTION; total is 987654.",
  );
  assert.deepEqual(result.observations[0]?.result, {
    success: true,
    data: privateRecordResult,
  });
  assert.deepEqual(result.observations[1]?.result, {
    success: true,
    data: privateReportResult,
  });
  assert.equal(audit.agentStarts[0]?.request, "[agent request redacted]");
  assert.deepEqual(
    audit.skillStarts.map(({ input }) => input),
    [{ redacted: true }, { redacted: true }],
  );
  assert.deepEqual(
    audit.skillFinishes.map(({ result: auditResult }) => auditResult),
    [{ redacted: true }, { redacted: true }],
  );

  const persistedPayloads = JSON.stringify({
    request: audit.agentStarts[0]?.request,
    inputs: audit.skillStarts.map(({ input }) => input),
    results: audit.skillFinishes.map(
      ({ result: auditResult }) => auditResult,
    ),
  });
  for (const privateValue of [
    "987654",
    "SECRET_DINNER_DESCRIPTION",
    "2042-01-PRIVATE_FROM",
    "2042-02-PRIVATE_TO",
    "PRIVATE_SHEET_ROW_ID",
    "PRIVATE_REPORT_ROW_ID",
    "SECRET_SHEET_ROW",
    '"amount"',
    '"description"',
    '"totals"',
    '"rows"',
  ]) {
    assert.equal(persistedPayloads.includes(privateValue), false);
  }
});

test("expense failure audit keeps status and error code but redacts its payload", async () => {
  const audit = new RecordingAudit();
  const registry = new SkillRegistry();
  registry.register({
    name: "expense_report",
    description: "Reads an expense report.",
    inputDescription: '{ "from": string }',
    inputSchema: z.object({ from: z.string() }).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return {
        success: false,
        error: {
          code: "SHEET_UNAVAILABLE",
          message: "PRIVATE_FAILURE_DETAIL",
        },
      };
    },
  });
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    audit,
  );

  const result = await executor.execute(
    "expense_report",
    { from: "PRIVATE_DATE_FILTER" },
    {
      agentRunId: "30000000-0000-4000-8000-000000000003",
      conversationId: request.conversationId,
      userId: request.userId,
      userName: request.userName,
      timeZone: request.timeZone,
      now: () => new Date("2026-08-20T00:00:00Z"),
    },
    { userAuthorized: true },
  );

  assert.deepEqual(result, {
    success: false,
    error: {
      code: "SHEET_UNAVAILABLE",
      message: "PRIVATE_FAILURE_DETAIL",
    },
  });
  assert.deepEqual(audit.skillStarts[0]?.input, { redacted: true });
  assert.deepEqual(audit.skillFinishes[0]?.result, { redacted: true });
  assert.equal(audit.skillFinishes[0]?.status, "failed");
  assert.equal(audit.skillFinishes[0]?.errorCode, "SHEET_UNAVAILABLE");
  assert.equal(
    JSON.stringify([
      audit.skillStarts[0]?.input,
      audit.skillFinishes[0]?.result,
    ]).includes("PRIVATE"),
    false,
  );
});

test("agent requests are redacted while non-expense skill payloads remain intact", async () => {
  const audit = new RecordingAudit();
  const registry = new SkillRegistry();
  const webInput = { query: "PRIVATE_WEB_QUERY" };
  const webResult = {
    answer: "PRIVATE_WEB_ANSWER",
    sources: [{ url: "https://example.com/private-source" }],
  };
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return { success: true, data: webResult };
    },
  });
  const decisions = [
    {
      type: "skill_call" as const,
      skill: "web_research",
      selectedSkills: ["web_research"],
      arguments: webInput,
      authorization: "user_authorized" as const,
    },
    {
      type: "respond" as const,
      outcome: "success" as const,
      message: "PRIVATE_WEB_ANSWER",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide() {
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine(), audit),
    registry,
    8,
    undefined,
    undefined,
    audit,
  );
  const userMessage = "Research PRIVATE_WEB_QUERY.";

  await loop.run({
    ...request,
    userMessage,
    allowedSkills: ["web_research"],
  });

  assert.equal(audit.agentStarts[0]?.request, "[agent request redacted]");
  assert.deepEqual(audit.skillStarts[0]?.input, webInput);
  assert.deepEqual(audit.skillFinishes[0]?.result, {
    success: true,
    data: webResult,
  });
});

test("skill audit recursively redacts nested secrets without changing execution results", async () => {
  const audit = new RecordingAudit();
  const registry = new SkillRegistry();
  const privateInput = {
    query: "PUBLIC_QUERY",
    transport: {
      apiKey: "INPUT_API_KEY_SECRET",
      nested: [
        {
          authorization: "Bearer input-private-token",
          note: "password=INPUT_PASSWORD_SECRET",
        },
      ],
    },
  };
  const privateResult = {
    answer: "PUBLIC_ANSWER",
    diagnostic: {
      refreshToken: "RESULT_REFRESH_TOKEN_SECRET",
      detail: "Bearer result-private-token",
    },
  };
  registry.register({
    name: "nested_audit_fixture",
    description: "Returns a nested audit-sanitization fixture.",
    inputDescription: '{ "query": string, "transport": object }',
    inputSchema: z
      .object({
        query: z.string(),
        transport: z
          .object({
            apiKey: z.string(),
            nested: z.array(
              z
                .object({
                  authorization: z.string(),
                  note: z.string(),
                })
                .strict(),
            ),
          })
          .strict(),
      })
      .strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return { success: true, data: privateResult };
    },
  });

  const result = await new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    audit,
  ).execute("nested_audit_fixture", privateInput, {
    agentRunId: "30000000-0000-4000-8000-000000000003",
    conversationId: request.conversationId,
    userId: request.userId,
    userName: request.userName,
    timeZone: request.timeZone,
    now: () => new Date("2026-08-20T00:00:00Z"),
  });

  assert.deepEqual(result, { success: true, data: privateResult });
  assert.deepEqual(audit.skillStarts[0]?.input, {
    query: "PUBLIC_QUERY",
    transport: {
      apiKey: "[REDACTED]",
      nested: [
        {
          authorization: "[REDACTED]",
          note: "password=[REDACTED]",
        },
      ],
    },
  });
  assert.deepEqual(audit.skillFinishes[0]?.result, {
    success: true,
    data: {
      answer: "PUBLIC_ANSWER",
      diagnostic: {
        refreshToken: "[REDACTED]",
        detail: "Bearer [REDACTED]",
      },
    },
  });
  assert.equal(audit.skillStarts[0]?.executionMode, "AUTO");
  assert.equal(audit.skillStarts[0]?.mutability, "read");
  assert.equal(audit.skillStarts[0]?.impact, "normal");
  assert.equal(audit.skillStarts[0]?.confirmationId, null);

  const persistedPayloads = JSON.stringify({
    input: audit.skillStarts[0]?.input,
    result: audit.skillFinishes[0]?.result,
  });
  for (const secret of [
    "INPUT_API_KEY_SECRET",
    "input-private-token",
    "INPUT_PASSWORD_SECRET",
    "RESULT_REFRESH_TOKEN_SECRET",
    "result-private-token",
  ]) {
    assert.equal(persistedPayloads.includes(secret), false);
  }
});

test("max-step termination is finalized without leaking error text", async () => {
  const audit = new RecordingAudit();
  const registry = new SkillRegistry();
  registry.register({
    name: "missing",
    description: "Always fails for the bounded-loop fixture.",
    inputDescription: "{}",
    inputSchema: z.object({}).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return {
        success: false,
        error: { code: "FIXTURE_FAILURE", message: "Fixture failure." },
      };
    },
  });
  const planner: AgentPlanner = {
    async decide() {
      return {
        type: "skill_call",
        skill: "missing",
        selectedSkills: ["missing"],
        arguments: {},
        authorization: "user_authorized",
      };
    },
  };
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    audit,
  );
  const loop = new AgentLoop(
    planner,
    executor,
    registry,
    1,
    undefined,
    undefined,
    audit,
  );

  const result = await loop.run(request);
  assert.equal(result.kind, "response");
  assert.match(result.response ?? "", /couldn't complete this request safely/i);
  assert.equal(audit.agentFinishes[0]?.status, "max_steps");
  assert.equal(audit.agentFinishes[0]?.errorCode, "AgentMaxStepsError");
  assert.equal(audit.skillFinishes[0]?.errorCode, "FIXTURE_FAILURE");
});

test("a successful side effect remains successful when audit finalization fails", async () => {
  const audit = new RecordingAudit();
  let finishAttempts = 0;
  audit.finishSkillRun = async () => {
    finishAttempts += 1;
    throw new Error("private audit database failure");
  };
  const auditErrors: unknown[] = [];
  const registry = new SkillRegistry();
  let writes = 0;
  registry.register({
    name: "record_expense",
    description: "Records one expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute(input) {
      writes += 1;
      return {
        success: true,
        data: { expenseId: "sheet-row-1", amount: input.amount },
      };
    },
  });
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    audit,
    () => "40000000-0000-4000-8000-000000000004",
    () => 10,
    (error) => auditErrors.push(error),
  );

  const result = await executor.execute(
    "record_expense",
    { amount: 45 },
    {
      agentRunId: "30000000-0000-4000-8000-000000000003",
      conversationId: request.conversationId,
      userId: request.userId,
      userName: request.userName,
      timeZone: request.timeZone,
      now: () => new Date("2026-08-20T00:00:00Z"),
    },
    { userAuthorized: true },
  );

  assert.deepEqual(result, {
    success: true,
    data: { expenseId: "sheet-row-1", amount: 45 },
  });
  assert.equal(writes, 1);
  assert.equal(finishAttempts, 1);
  assert.equal(auditErrors.length, 1);
});

test("agent audit finalization cannot replace an already successful clarification", async () => {
  const audit = new RecordingAudit();
  let finishAttempts = 0;
  audit.finishAgentRun = async () => {
    finishAttempts += 1;
    throw new Error("private audit database failure");
  };
  const auditErrors: unknown[] = [];
  const registry = new SkillRegistry();
  const loop = new AgentLoop(
    {
      async decide() {
        return {
          type: "clarify",
          message: "Completed.",
        };
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    8,
    undefined,
    undefined,
    audit,
    undefined,
    (error) => auditErrors.push(error),
  );

  const result = await loop.run(request);

  assert.equal(result.response, "Completed.");
  assert.equal(finishAttempts, 1);
  assert.equal(auditErrors.length, 1);
});
