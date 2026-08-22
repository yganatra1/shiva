import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  AgentCancelledError,
  AgentLoop,
  AgentTimeoutError,
} from "../src/agent/agent-loop.js";
import { ShivaOrchestrator } from "../src/agent/orchestrator.js";
import {
  AgentPlannerError,
  ShivaAgentPlanner,
} from "../src/agent/planner.js";
import type {
  AgentDecision,
  AgentPlanner,
  AgentPlanningContext,
  AgentRequest,
} from "../src/agent/types.js";
import type { ChatInput } from "../src/brain/ai-provider.js";
import type { PackSummary, ShivaSkill } from "../src/skills/types.js";
import {
  ConfirmationService,
  InMemoryConfirmationStore,
} from "../src/security/confirmation.js";
import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { PackRegistry } from "../src/skills/pack-registry.js";
import { SkillRegistry } from "../src/skills/registry.js";

const request: AgentRequest = {
  userMessage: "Add INR 450 for pizza.",
  conversationId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  contextMessages: [{ role: "user", content: "Add INR 450 for pizza." }],
};

test("agent loop executes a skill, observes confirmed output, then responds", async () => {
  const registry = new SkillRegistry();
  let executionCount = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute(input) {
      executionCount += 1;
      return {
        success: true,
        data: { expenseId: "expense-1", amount: input.amount },
      };
    },
  });
  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { amount: 450 },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      outcome: "success",
      message: "Added INR 450 for pizza.",
    },
  ];
  const planner: AgentPlanner = {
    async decide(context) {
      contexts.push(context);
      const decision = decisions.shift();
      if (!decision) throw new Error("No fake decision available.");
      return decision;
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    8,
    () => new Date("2026-08-20T00:00:00Z"),
    () => "30000000-0000-4000-8000-000000000003",
  );

  const result = await loop.run(request);

  assert.equal(executionCount, 1);
  assert.equal(result.response, "Added INR 450 for pizza.");
  assert.equal(result.steps, 2);
  assert.equal(contexts[0]?.observations.length, 0);
  assert.deepEqual(contexts[1]?.observations[0]?.result, {
    success: true,
    data: { expenseId: "expense-1", amount: 450 },
  });
});

test("agent loop resumes only the exact action approved by a pending confirmation", async () => {
  const confirmationId = "40000000-0000-4000-8000-000000000004";
  const confirmationStore = new InMemoryConfirmationStore();
  const confirmations = new ConfirmationService(
    confirmationStore,
    300_000,
    () => confirmationId,
  );
  const registry = new SkillRegistry();
  let executionCount = 0;
  registry.register({
    name: "sensitive_fixture",
    description: "Executes one sensitive fixture action.",
    inputDescription: '{ "target": string, "force": boolean }',
    inputSchema: z
      .object({ target: z.string().min(1), force: z.boolean() })
      .strict(),
    pack: "test",
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "This fixture action is sensitive.",
    },
    async execute(input) {
      executionCount += 1;
      return { success: true, data: { completed: true, ...input } };
    },
  });
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    undefined,
    undefined,
    undefined,
    undefined,
    confirmations,
  );
  const now = () => new Date("2026-08-20T00:00:00Z");
  const initialDecisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "sensitive_fixture",
      selectedSkills: ["sensitive_fixture"],
      arguments: { target: "shiva", force: true },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      outcome: "failure",
      message: "This exact action needs confirmation.",
    },
  ];
  const initialLoop = new AgentLoop(
    {
      async decide() {
        const decision = initialDecisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    executor,
    registry,
    8,
    now,
  );

  const pendingResult = await initialLoop.run({
    ...request,
    userMessage: "Execute the sensitive fixture action.",
  });
  const pendingObservation = pendingResult.observations[0];
  assert.ok(pendingObservation && !pendingObservation.result.success);
  if (!pendingObservation || pendingObservation.result.success) {
    assert.fail("Expected a pending confirmation observation.");
  }
  assert.equal(
    pendingObservation.result.error.confirmation?.id,
    confirmationId,
  );
  assert.equal(executionCount, 0);

  const approvalContexts: AgentPlanningContext[] = [];
  const approvalDecisions: AgentDecision[] = [
    {
      type: "approve_confirmation",
      confirmationId,
      skill: "sensitive_fixture",
      arguments: { force: true, target: "shiva" },
    },
    {
      type: "respond",
      outcome: "success",
      message: "The exact sensitive action completed.",
    },
  ];
  const approvalLoop = new AgentLoop(
    {
      async decide(context) {
        approvalContexts.push(context);
        const decision = approvalDecisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    executor,
    registry,
    8,
    now,
  );

  const approvedResult = await approvalLoop.run({
    ...request,
    userMessage: "Yes, approve that exact action.",
  });

  assert.equal(approvalContexts[0]?.pendingConfirmation?.id, confirmationId);
  assert.equal(executionCount, 1);
  assert.equal(approvedResult.response, "The exact sensitive action completed.");
  assert.deepEqual(approvedResult.observations[0]?.result, {
    success: true,
    data: { completed: true, target: "shiva", force: true },
  });
  assert.equal(
    (await confirmationStore.findById(confirmationId))?.status,
    "EXECUTED",
  );
});

test("agent loop denies a pending confirmation without executing its action", async () => {
  const confirmationId = "50000000-0000-4000-8000-000000000005";
  const confirmationStore = new InMemoryConfirmationStore();
  const confirmations = new ConfirmationService(
    confirmationStore,
    300_000,
    () => confirmationId,
  );
  const registry = new SkillRegistry();
  let executionCount = 0;
  registry.register({
    name: "sensitive_fixture",
    description: "Executes one sensitive fixture action.",
    inputDescription: '{ "target": string }',
    inputSchema: z.object({ target: z.string().min(1) }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "sensitive" },
    async execute() {
      executionCount += 1;
      return { success: true, data: { completed: true } };
    },
  });
  await confirmations.request({
    agentRunId: "30000000-0000-4000-8000-000000000003",
    userId: request.userId,
    conversationId: request.conversationId,
    skill: "sensitive_fixture",
    arguments: { target: "shiva" },
    reason: "This fixture action is sensitive.",
    executionMode: "FULL_ACCESS",
    mutability: "write",
    impact: "sensitive",
    settingsRevision: 0,
    now: new Date("2026-08-20T00:00:00Z"),
  });
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    undefined,
    undefined,
    undefined,
    undefined,
    confirmations,
  );
  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    { type: "deny_confirmation", confirmationId },
    {
      type: "respond",
      outcome: "failure",
      message: "Cancelled the pending action.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    executor,
    registry,
    8,
    () => new Date("2026-08-20T00:00:00Z"),
  );

  const result = await loop.run({
    ...request,
    userMessage: "No, cancel that action.",
  });

  assert.equal(contexts[0]?.pendingConfirmation?.id, confirmationId);
  assert.equal(executionCount, 0);
  assert.equal(result.response, "Cancelled the pending action.");
  const denialObservation = result.observations[0];
  assert.ok(denialObservation && !denialObservation.result.success);
  if (!denialObservation || denialObservation.result.success) {
    assert.fail("Expected a denied confirmation observation.");
  }
  assert.equal(denialObservation.result.error.code, "CONFIRMATION_DENIED");
  assert.equal(
    (await confirmationStore.findById(confirmationId))?.status,
    "DENIED",
  );
});

test("agent loop executes an identical skill call only once per run", async () => {
  const registry = new SkillRegistry();
  let executionCount = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number, "description": string }',
    inputSchema: z
      .object({ amount: z.number().positive(), description: z.string() })
      .strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute(input) {
      executionCount += 1;
      return {
        success: true,
        data: { expenseId: `expense-${executionCount}`, ...input },
      };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { amount: 450, description: "Pizza" },
      authorization: "user_authorized",
    },
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { description: "Pizza", amount: 450 },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      outcome: "success",
      message: "Added INR 450 for pizza.",
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
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run({
    ...request,
    allowedSkills: ["record_expense"],
  });

  assert.equal(executionCount, 1);
  assert.equal(result.observations.length, 1);
});

test("agent loop does not re-execute an identical unavailable skill", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      executions += 1;
      return {
        success: false,
        error: {
          code: "WEB_RESEARCH_UNAVAILABLE",
          message: "Web research is unavailable.",
        },
      };
    },
  });
  const contexts: AgentPlanningContext[] = [];
  const failedCall: AgentDecision = {
    type: "skill_call",
    skill: "web_research",
    selectedSkills: ["web_research"],
    arguments: { query: "Ahmedabad weather" },
    authorization: "user_authorized",
  };
  const decisions: AgentDecision[] = [
    failedCall,
    failedCall,
    {
      type: "respond",
      outcome: "failure",
      message: "Web research is not configured.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run(request);
  assert.equal(executions, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.response, "Web research is not configured.");
  assert.match(contexts[2]?.plannerFeedback ?? "", /already failed/i);
});

test("agent loop preserves distinct record_expense calls in one run", async () => {
  const registry = new SkillRegistry();
  const executedAmounts: number[] = [];
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute(input) {
      executedAmounts.push(input.amount);
      return { success: true, data: { amount: input.amount } };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { amount: 450 },
      authorization: "user_authorized",
    },
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { amount: 200 },
      authorization: "user_authorized",
    },
    { type: "respond", outcome: "success", message: "Added both." },
  ];
  const loop = new AgentLoop(
    {
      async decide() {
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run({
    ...request,
    allowedSkills: ["record_expense"],
  });

  assert.deepEqual(executedAmounts, [450, 200]);
  assert.equal(result.observations.length, 2);
});

test("agent loop corrects a response that is missing required skill evidence", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      executions += 1;
      return { success: true, data: { expenseId: "expense-1" } };
    },
  });
  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    {
      type: "respond",
      outcome: "success",
      message: "The expense was added.",
    },
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { amount: 450 },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      outcome: "success",
      message: "The expense was added.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run(request);
  assert.equal(executions, 1);
  assert.equal(result.response, "The expense was added.");
  assert.match(contexts[1]?.plannerFeedback ?? "", /no skill plan or tool evidence/i);
});

test("agent loop accepts an early failure from a selected prerequisite skill", async () => {
  const registry = new SkillRegistry();
  let expenseExecutions = 0;
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return {
        success: false,
        error: { code: "SEARCH_UNAVAILABLE", message: "Search unavailable." },
      };
    },
  });
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      expenseExecutions += 1;
      return { success: true, data: { expenseId: "unexpected" } };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "web_research",
      selectedSkills: ["record_expense", "web_research"],
      arguments: { query: "current price" },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      outcome: "failure",
      message: "I could not research the current price, so I did not record it.",
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
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run({
    ...request,
    allowedSkills: ["web_research", "record_expense"],
  });

  assert.equal(result.response, "I could not research the current price, so I did not record it.");
  assert.equal(expenseExecutions, 0);
  assert.equal(result.observations.length, 1);
});

test("agent loop feeds an out-of-scope call back to the planner for correction", async () => {
  const registry = new SkillRegistry();
  let expenseExecutions = 0;
  let webExecutions = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      expenseExecutions += 1;
      return { success: true, data: { expenseId: "unexpected" } };
    },
  });
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      webExecutions += 1;
      return { success: true, data: { answer: "grounded" } };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { amount: 999 },
      authorization: "user_authorized",
    },
    {
      type: "skill_call",
      skill: "web_research",
      selectedSkills: ["web_research"],
      arguments: { query: "latest TTS models" },
      authorization: "user_authorized",
    },
    { type: "respond", outcome: "success", message: "Research complete." },
  ];
  const contexts: AgentPlanningContext[] = [];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run({
    ...request,
    allowedSkills: ["web_research"],
  });
  assert.equal(expenseExecutions, 0);
  assert.equal(webExecutions, 1);
  assert.equal(result.response, "Research complete.");
  assert.match(contexts[1]?.plannerFeedback ?? "", /scope is frozen/i);
});

test("agent loop never executes a repeated adversarial cross-skill call", async () => {
  const registry = new SkillRegistry();
  let expenseExecutions = 0;
  let webExecutions = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    pack: "test",
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      expenseExecutions += 1;
      return { success: true, data: { expenseId: "should-not-exist" } };
    },
  });
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute(input) {
      webExecutions += 1;
      return { success: true, data: { answer: input.query } };
    },
  });
  const invalidDecision: AgentDecision = {
    type: "skill_call",
    skill: "record_expense",
    selectedSkills: ["record_expense"],
    arguments: { amount: 999 },
    authorization: "user_authorized",
  };
  const loop = new AgentLoop(
    {
      async decide() {
        return invalidDecision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    2,
  );

  const result = await loop.run({
    ...request,
    userMessage: "Research the latest TTS models.",
    allowedSkills: ["web_research"],
  });

  assert.equal(result.kind, "direct_chat");
  assert.equal(expenseExecutions, 0);
  assert.equal(webExecutions, 0);
});

test("agent loop corrects clarification attempted after tool execution", async () => {
  const registry = new SkillRegistry();
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return { success: true, data: { answer: "grounded" } };
    },
  });
  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "web_research",
      selectedSkills: ["web_research"],
      arguments: { query: "Ahmedabad weather" },
      authorization: "user_authorized",
    },
    { type: "clarify", message: "Which Ahmedabad?" },
    {
      type: "respond",
      outcome: "success",
      message: "Here is the grounded forecast.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run(request);
  assert.equal(result.response, "Here is the grounded forecast.");
  assert.match(contexts[2]?.plannerFeedback ?? "", /clarify was rejected/i);
  assert.equal(result.observations.length, 1);
});

test("agent loop retries an unknown skill scope then falls back to core chat", async () => {
  const registry = new SkillRegistry();
  let plannerCalls = 0;
  const planner: AgentPlanner = {
    async decide() {
      plannerCalls += 1;
      return {
        type: "skill_call",
        skill: "missing",
        selectedSkills: ["missing"],
        arguments: {},
        authorization: "user_authorized",
      };
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    2,
  );

  const result = await loop.run(request);
  assert.equal(plannerCalls, 2);
  assert.equal(result.kind, "direct_chat");
  if (result.kind === "direct_chat") {
    assert.equal(result.plannerFallback, "INVALID_SCOPE");
  }
});

test("agent loop sanitizes cancellation and finalizes without another decision", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private disconnect reason"));
  let plannerCalls = 0;
  const registry = new SkillRegistry();
  const loop = new AgentLoop(
    {
      async decide() {
        plannerCalls += 1;
        return { type: "respond", outcome: "failure", message: "no" };
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  await assert.rejects(
    loop.run({ ...request, signal: controller.signal }),
    AgentCancelledError,
  );
  assert.equal(plannerCalls, 0);
});

test("agent loop aborts planner work at the request deadline", async () => {
  const registry = new SkillRegistry();
  let plannerObservedAbort = false;
  const loop = new AgentLoop(
    {
      async decide(context) {
        await new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, 100);
          const signal = context.request.signal;
          if (signal?.aborted) {
            plannerObservedAbort = true;
            clearTimeout(fallback);
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              plannerObservedAbort = true;
              clearTimeout(fallback);
              resolve();
            },
            { once: true },
          );
        });
        return { type: "respond", outcome: "failure", message: "Too late." };
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    8,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    10,
  );

  await assert.rejects(loop.run(request), AgentTimeoutError);
  assert.equal(plannerObservedAbort, true);
});

test("provider-neutral planner requests strict JSON and validates the decision", async () => {
  const inputs: ChatInput[] = [];
  const planner = new ShivaAgentPlanner({
    async chat(input) {
      inputs.push(input);
      return {
        content:
          '```json\n{"type":"skill_call","skill":"record_expense","selectedSkills":["record_expense"],"arguments":{"amount":450},"authorization":"user_authorized"}\n```',
      };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  const decision = await planner.decide({
    request,
    packs: [],
    openPacks: [],
    skills: [
      {
        name: "record_expense",
        description: "Records an expense.",
        inputDescription: '{ "amount": number }',
        configured: true,
        pack: "test",
        execution: { mutability: "write", impact: "normal" },
      },
    ],
    observations: [],
    step: 1,
    maxSteps: 8,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  assert.deepEqual(decision, {
    type: "skill_call",
    skill: "record_expense",
    selectedSkills: ["record_expense"],
    arguments: { amount: 450 },
    authorization: "user_authorized",
  });
  assert.equal(typeof inputs[0]?.responseFormat, "object");
  assert.match(inputs[0]?.messages[0]?.content ?? "", /Never claim an action succeeded/);
  assert.equal(inputs[0]?.temperature, 0);
});

test("the planner prompt gives a worked example for resolving a CONFIRMATION_REQUIRED observation", async () => {
  const inputs: ChatInput[] = [];
  const planner = new ShivaAgentPlanner({
    async chat(input) {
      inputs.push(input);
      return { content: '{"type":"direct_chat"}' };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  await planner.decide({
    request,
    packs: [],
    openPacks: [],
    skills: [],
    observations: [],
    step: 1,
    maxSteps: 8,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  const prompt = inputs[0]?.messages[0]?.content ?? "";
  // A concrete worked example, not just an abstract rule, since asking a
  // question via a "failure" response is an unusual enough pattern that a
  // smaller model needs a literal example to reliably converge on it instead
  // of retrying the action or exhausting the step budget.
  assert.match(prompt, /normal, expected stop, not a failed attempt to fix/);
  assert.match(
    prompt,
    /"respond","outcome":"failure","message":"Switch execution mode from Auto to Full Access\?/,
  );
  assert.match(prompt, /never substitute a human-readable label, different casing/);
});

test("planner skill calls fail closed when authorization is omitted", async () => {
  let attempts = 0;
  const planner = new ShivaAgentPlanner({
    async chat() {
      attempts += 1;
      return {
        content:
          '{"type":"skill_call","skill":"record_expense","selectedSkills":["record_expense"],"arguments":{"amount":450}}',
      };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  await assert.rejects(
    planner.decide({
      request,
      packs: [],
      openPacks: [],
      skills: [
        {
          name: "record_expense",
          description: "Records an expense.",
          inputDescription: '{ "amount": number }',
          configured: true,
          pack: "test",
          execution: { mutability: "write", impact: "normal" },
        },
      ],
      observations: [],
      step: 1,
      maxSteps: 8,
      now: new Date("2026-08-20T00:00:00Z"),
    }),
    AgentPlannerError,
  );
  assert.equal(attempts, 2);
});

test("the planner's onTrace logs the request, the raw response, and a parse rejection", async () => {
  const traces: Array<{ detail: Record<string, unknown>; message: string }> = [];
  let attempts = 0;
  const planner = new ShivaAgentPlanner(
    {
      async chat() {
        attempts += 1;
        return {
          content:
            attempts === 1
              ? "not valid json"
              : '{"type":"direct_chat"}',
        };
      },
      async *streamChat() {
        throw new Error("Planner decisions must use structured chat().");
      },
    },
    (detail, message) => traces.push({ detail, message }),
  );

  const decision = await planner.decide({
    request,
    packs: [],
    openPacks: [],
    skills: [],
    observations: [],
    step: 1,
    maxSteps: 8,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  assert.deepEqual(decision, { type: "direct_chat" });
  const messages = traces.map((entry) => entry.message);
  assert.deepEqual(messages, [
    "agent planner request",
    "agent planner response rejected",
    "agent planner request",
    "agent planner response",
  ]);
  assert.equal(traces[0]?.detail.step, 1);
  assert.ok(typeof traces[0]?.detail.systemPrompt === "string");
  assert.equal(traces[1]?.detail.rawResponse, "not valid json");
  assert.deepEqual(traces[3]?.detail.decision, { type: "direct_chat" });
});

test("orchestrator sends every turn to semantic planner selection", async () => {
  const messages: string[] = [];
  const noOpLoop: Pick<AgentLoop, "run"> = {
    async run(input) {
      messages.push(input.userMessage);
      return {
        kind: "direct_chat",
        runId: "30000000-0000-4000-8000-000000000003",
        response: undefined,
        steps: 1,
        observations: [],
      };
    },
  };
  const orchestrator = new ShivaOrchestrator(noOpLoop);

  const inputs = [
    "Add ₹450 for pizza",
    "I spent ₹450 on pizza",
    "We just paid INR 900 for dinner",
    "What did I spend today?",
    "Research the latest TTS models",
    "What is the cost of an RTX 3090?",
    "What is Newton's third law?",
  ];
  for (const userMessage of inputs) {
    await orchestrator.run({ ...request, userMessage });
  }
  assert.deepEqual(messages, inputs);
});

test("orchestrator leaves semantic skill selection to the planner", async () => {
  let captured: AgentRequest | undefined;
  const orchestrator = new ShivaOrchestrator(
    {
      async run(scopedRequest) {
        captured = scopedRequest;
        return {
          kind: "response",
          runId: "30000000-0000-4000-8000-000000000003",
          response: "Completed.",
          steps: 1,
          observations: [],
        };
      },
    },
  );

  await orchestrator.run({
    ...request,
    userMessage:
      "Research current GPU pricing and record the cheapest as an expense.",
  });

  assert.equal(captured?.allowedSkills, undefined);
});

function fixtureSkill(
  name: string,
  pack: string,
): ShivaSkill<Record<string, never>, Record<string, never>> {
  return {
    name,
    description: `${name} fixture skill.`,
    inputDescription: "{}",
    pack,
    inputSchema: z.object({}).strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return { success: true, data: {} };
    },
  };
}

test("open_packs is additive and reveals only the opened packs' skills before a skill_call freezes the scope", async () => {
  const packs = new PackRegistry();
  packs.register({ name: "alpha", description: "Alpha pack." });
  packs.register({ name: "beta", description: "Beta pack." });
  const registry = new SkillRegistry(packs);
  registry.register(fixtureSkill("alpha_skill", "alpha"));
  let betaExecutions = 0;
  registry.register({
    ...fixtureSkill("beta_skill", "beta"),
    async execute() {
      betaExecutions += 1;
      return { success: true, data: { done: true } };
    },
  });

  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    { type: "open_packs", packs: ["alpha"] },
    { type: "open_packs", packs: ["beta"] },
    {
      type: "skill_call",
      skill: "beta_skill",
      selectedSkills: ["beta_skill"],
      arguments: {},
      authorization: "user_authorized",
    },
    { type: "respond", outcome: "success", message: "Done." },
  ];
  const planner: AgentPlanner = {
    async decide(context) {
      contexts.push(context);
      const decision = decisions.shift();
      if (!decision) throw new Error("No fake decision available.");
      return decision;
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    8,
    () => new Date("2026-08-20T00:00:00Z"),
    () => "30000000-0000-4000-8000-000000000003",
  );

  const result = await loop.run(request);

  assert.equal(betaExecutions, 1);
  assert.equal(result.response, "Done.");

  assert.deepEqual(contexts[0]?.openPacks, []);
  assert.deepEqual(contexts[0]?.skills, []);
  assert.equal(contexts[0]?.packs.length, 2);

  assert.deepEqual(contexts[1]?.openPacks, ["alpha"]);
  assert.deepEqual(
    contexts[1]?.skills.map((skill) => skill.name),
    ["alpha_skill"],
  );

  assert.deepEqual(contexts[2]?.openPacks, ["alpha", "beta"]);
  assert.deepEqual(
    contexts[2]?.skills.map((skill) => skill.name).sort(),
    ["alpha_skill", "beta_skill"],
  );

  assert.deepEqual(
    contexts[3]?.skills.map((skill) => skill.name),
    ["beta_skill"],
  );
});

test("open_packs is rejected once the skill scope is frozen", async () => {
  const packs = new PackRegistry();
  packs.register({ name: "alpha", description: "Alpha pack." });
  const registry = new SkillRegistry(packs);
  registry.register(fixtureSkill("alpha_skill", "alpha"));

  const feedbacks: (string | undefined)[] = [];
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "alpha_skill",
      selectedSkills: ["alpha_skill"],
      arguments: {},
      authorization: "user_authorized",
    },
    { type: "open_packs", packs: ["alpha"] },
    { type: "respond", outcome: "success", message: "Done." },
  ];
  const planner: AgentPlanner = {
    async decide(context) {
      feedbacks.push(context.plannerFeedback);
      const decision = decisions.shift();
      if (!decision) throw new Error("No fake decision available.");
      return decision;
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    8,
    () => new Date("2026-08-20T00:00:00Z"),
    () => "30000000-0000-4000-8000-000000000003",
  );

  const result = await loop.run(request);

  assert.equal(result.response, "Done.");
  assert.match(feedbacks[2] ?? "", /already frozen/);
});

test("an invalid open_packs request is corrected without crashing the run", async () => {
  const packs = new PackRegistry();
  packs.register({ name: "alpha", description: "Alpha pack." });
  const registry = new SkillRegistry(packs);
  registry.register(fixtureSkill("alpha_skill", "alpha"));

  const feedbacks: (string | undefined)[] = [];
  const decisions: AgentDecision[] = [
    { type: "open_packs", packs: ["nonexistent_pack"] },
    { type: "open_packs", packs: ["alpha"] },
    {
      type: "skill_call",
      skill: "alpha_skill",
      selectedSkills: ["alpha_skill"],
      arguments: {},
      authorization: "user_authorized",
    },
    { type: "respond", outcome: "success", message: "Done." },
  ];
  const planner: AgentPlanner = {
    async decide(context) {
      feedbacks.push(context.plannerFeedback);
      const decision = decisions.shift();
      if (!decision) throw new Error("No fake decision available.");
      return decision;
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    8,
    () => new Date("2026-08-20T00:00:00Z"),
    () => "30000000-0000-4000-8000-000000000003",
  );

  const result = await loop.run(request);

  assert.equal(result.response, "Done.");
  assert.match(feedbacks[1] ?? "", /invalid or empty pack list/);
  assert.match(feedbacks[1] ?? "", /alpha/);
});

test("the unscoped planner prompt scales with pack count, not with each pack's skill count", async () => {
  const makePacks = (count: number): PackSummary[] =>
    Array.from({ length: count }, (_, index) => ({
      name: `pack_${index}`,
      description:
        `Synthetic capability pack number ${index} used to verify the ` +
        "unscoped prompt does not scale with total registered skill count.",
      // A high skillCount on every pack: if the prompt ever regresses into
      // rendering full per-skill blocks for an unscoped turn (today's
      // pre-middle-layer behavior), this is what would balloon the size.
      skillCount: 20,
      configured: true,
    }));

  async function promptFor(packs: PackSummary[]): Promise<string> {
    const inputs: ChatInput[] = [];
    const planner = new ShivaAgentPlanner({
      async chat(input) {
        inputs.push(input);
        return { content: '{"type":"direct_chat"}' };
      },
      async *streamChat() {
        throw new Error("Planner decisions must use structured chat().");
      },
    });
    await planner.decide({
      request,
      packs,
      openPacks: [],
      skills: [],
      observations: [],
      step: 1,
      maxSteps: 8,
      now: new Date("2026-08-20T00:00:00Z"),
    });
    return inputs[0]?.messages[0]?.content ?? "";
  }

  const smallPrompt = await promptFor(makePacks(2));
  const largePrompt = await promptFor(makePacks(40));

  assert.match(smallPrompt, /No skill definitions are visible yet/);
  assert.match(largePrompt, /No skill definitions are visible yet/);

  const perExtraPackCost =
    (largePrompt.length - smallPrompt.length) / (40 - 2);
  // Rendering a pack line costs roughly 150-250 characters. Rendering one
  // full skill definition block costs roughly 250-400 characters, and each
  // synthetic pack above claims 20 skills — so a regression back into
  // per-skill rendering on an unscoped turn would push this well past 1,000
  // characters per pack. 600 cleanly separates the two.
  assert.ok(
    perExtraPackCost < 600,
    `Expected roughly constant per-pack prompt cost, got ${perExtraPackCost.toFixed(1)} characters/pack (small=${smallPrompt.length}, large=${largePrompt.length}).`,
  );
});
