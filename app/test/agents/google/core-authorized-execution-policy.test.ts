import assert from "node:assert/strict";
import { test } from "node:test";

import { CoreAuthorizedAgentExecutionPolicy } from "../../../src/agents/google/core-authorized-execution-policy.js";

test("a Core-authorized delegated task never starts a second confirmation flow", async () => {
  const policy = new CoreAuthorizedAgentExecutionPolicy();

  const normalWrite = await policy.evaluate({
    skill: "sheets_update",
    arguments: {},
    execution: { mutability: "write", impact: "normal" },
    userAuthorized: false,
    confirmed: false,
  });
  const sensitiveWrite = await policy.evaluate({
    skill: "future_sensitive_google_action",
    arguments: {},
    execution: { mutability: "write", impact: "sensitive" },
    userAuthorized: false,
    confirmed: false,
  });

  assert.equal(normalWrite.action, "execute");
  assert.equal(sensitiveWrite.action, "execute");
});
