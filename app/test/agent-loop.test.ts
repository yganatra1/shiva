import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  AgentCancelledError,
  AgentLoop,
  AgentTimeoutError,
} from "../src/agent/agent-loop.js";
import { ShivaOrchestrator } from "../src/agent/orchestrator.js";
import { ShivaAgentPlanner } from "../src/agent/planner.js";
import type {
  AgentDecision,
  AgentPlanner,
  AgentPlanningContext,
  AgentRequest,
} from "../src/agent/types.js";
import type { ChatInput } from "../src/brain/ai-provider.js";
import { PermissionPolicyEngine } from "../src/security/policy-engine.js";
import { SkillExecutor } from "../src/skills/executor.js";
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
    permissions: ["expenses.write"],
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    permissions: ["expenses.write"],
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
    },
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { description: "Pizza", amount: 450 },
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    permissions: ["web.read"],
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    permissions: ["expenses.write"],
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
    },
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { amount: 200 },
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    permissions: ["expenses.write"],
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    permissions: ["web.read"],
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
    permissions: ["expenses.write"],
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    permissions: ["expenses.write"],
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
    permissions: ["web.read"],
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
    },
    {
      type: "skill_call",
      skill: "web_research",
      selectedSkills: ["web_research"],
      arguments: { query: "latest TTS models" },
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    permissions: ["expenses.write"],
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
    permissions: ["web.read"],
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
    };
  const loop = new AgentLoop(
    {
      async decide() {
        return invalidDecision;
      },
    },
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    permissions: ["web.read"],
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
      };
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
    new SkillExecutor(registry, new PermissionPolicyEngine()),
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
          '```json\n{"type":"skill_call","skill":"record_expense","selectedSkills":["record_expense"],"arguments":{"amount":450}}\n```',
      };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  const decision = await planner.decide({
    request,
    skills: [
      {
        name: "record_expense",
        description: "Records an expense.",
        inputDescription: '{ "amount": number }',
        configured: true,
        permissions: ["expenses.write"],
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
  });
  assert.equal(typeof inputs[0]?.responseFormat, "object");
  assert.match(inputs[0]?.messages[0]?.content ?? "", /Never claim an action succeeded/);
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
