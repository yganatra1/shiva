import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  NOOP_AGENT_AUDIT,
  type FinishSkillRunInput,
} from "../src/agent/audit.js";
import {
  sanitizeAuditPayload,
  sanitizeAuditText,
} from "../src/security/audit-sanitizer.js";
import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { SkillContext } from "../src/skills/types.js";

const NOW = new Date("2026-08-22T10:00:00.000Z");
const skillContext: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => NOW,
};

test("generic audit sanitization covers structured fields and common inline credential formats", () => {
  const privateKey = [
    "-----BEGIN PRIVATE KEY-----",
    "PRIVATE_KEY_SECRET_SENTINEL",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const sanitized = sanitizeAuditPayload({
    secretAccessKey: "AWS_SECRET_SENTINEL",
    databaseUrl: "postgresql://admin:DB_PASSWORD_SENTINEL@db.internal/shiva",
    authToken: "AUTH_TOKEN_SENTINEL",
    notes: [
      "token=PLAIN_TOKEN_SENTINEL",
      "oauth_token=OAUTH_TOKEN_SENTINEL",
      "Bearer BEARER_TOKEN_SENTINEL",
      "github_pat_11AA_GITHUB_PAT_SECRET_SENTINEL",
      "ghp_ClassicSecretSentinel1234567890AB",
      "sk-proj-OPENAI_SECRET_SENTINEL1234567890",
      "AIzaSyGOOGLE_API_SECRET_SENTINEL1234567890",
      "eyJJWT_SECRET_SENTINEL.eyJPAYLOAD_SECRET_SENTINEL.signatureSECRET",
      privateKey,
      "safe diagnostic text",
    ],
  });
  const persisted = JSON.stringify(sanitized);

  for (const secret of [
    "AWS_SECRET_SENTINEL",
    "DB_PASSWORD_SENTINEL",
    "AUTH_TOKEN_SENTINEL",
    "PLAIN_TOKEN_SENTINEL",
    "OAUTH_TOKEN_SENTINEL",
    "BEARER_TOKEN_SENTINEL",
    "GITHUB_PAT_SECRET_SENTINEL",
    "ClassicSecretSentinel",
    "OPENAI_SECRET_SENTINEL",
    "GOOGLE_API_SECRET_SENTINEL",
    "JWT_SECRET_SENTINEL",
    "PRIVATE_KEY_SECRET_SENTINEL",
  ]) {
    assert.equal(persisted.includes(secret), false, secret);
  }
  assert.match(persisted, /safe diagnostic text/);
  assert.equal(sanitizeAuditText("ordinary status"), "ordinary status");
});

test("skill failure codes are sanitized before audit persistence without changing the tool result", async () => {
  const finishes: FinishSkillRunInput[] = [];
  const audit = {
    ...NOOP_AGENT_AUDIT,
    async finishSkillRun(input: FinishSkillRunInput) {
      finishes.push(input);
    },
  };
  const registry = new SkillRegistry();
  registry.register({
    name: "failure_fixture",
    description: "Returns a malformed provider error code fixture.",
    inputDescription: "{}",
    inputSchema: z.object({}).strict(),
    pack: "test",
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return {
        success: false,
        error: {
          code: "token=ERROR_CODE_SECRET_SENTINEL",
          message: "A safe public failure.",
        },
      };
    },
  });
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    audit,
  );

  const result = await executor.execute("failure_fixture", {}, skillContext);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "token=ERROR_CODE_SECRET_SENTINEL");
  }
  assert.equal(finishes.length, 1);
  assert.equal(
    JSON.stringify(finishes[0]).includes("ERROR_CODE_SECRET_SENTINEL"),
    false,
  );
});

test("confirmation reasons are sanitized before persistence and user-visible status", async () => {
  const registry = new SkillRegistry();
  registry.register({
    name: "sensitive_fixture",
    description: "Requests one sensitive fixture action.",
    inputDescription: "{}",
    inputSchema: z.object({}).strict(),
    pack: "test",
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "token=CONFIRMATION_REASON_SECRET_SENTINEL",
    },
    async execute() {
      return { success: true, data: {} };
    },
  });
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "sensitive_fixture",
    {},
    skillContext,
    { userAuthorized: true },
  );
  const pending = await executor.getPendingConfirmation(
    skillContext.userId,
    skillContext.conversationId,
    NOW,
  );

  assert.equal(result.success, false);
  assert.ok(pending);
  assert.equal(JSON.stringify(result).includes("CONFIRMATION_REASON_SECRET_SENTINEL"), false);
  assert.equal(JSON.stringify(pending).includes("CONFIRMATION_REASON_SECRET_SENTINEL"), false);
});
