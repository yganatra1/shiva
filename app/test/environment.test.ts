import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config/environment.js";

test("numeric SHIVA_KEEP_ALIVE values are normalized for the Ollama API", () => {
  const previousValue = process.env.SHIVA_KEEP_ALIVE;

  try {
    process.env.SHIVA_KEEP_ALIVE = "-1";
    assert.equal(loadConfig().keepAlive, -1);

    process.env.SHIVA_KEEP_ALIVE = "0";
    assert.equal(loadConfig().keepAlive, 0);

    process.env.SHIVA_KEEP_ALIVE = "3600";
    assert.equal(loadConfig().keepAlive, 3600);

    process.env.SHIVA_KEEP_ALIVE = "30m";
    assert.equal(loadConfig().keepAlive, "30m");
  } finally {
    if (previousValue === undefined) {
      delete process.env.SHIVA_KEEP_ALIVE;
    } else {
      process.env.SHIVA_KEEP_ALIVE = previousValue;
    }
  }
});
