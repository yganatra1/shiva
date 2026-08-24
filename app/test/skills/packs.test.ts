import assert from "node:assert/strict";
import { test } from "node:test";

import { createPackRegistry } from "../../src/skills/packs.js";

test("Core can omit the in-process Google pack while Google workers keep it", () => {
  assert.equal(createPackRegistry().has("google"), true);
  assert.equal(
    createPackRegistry({ includeGoogle: false }).has("google"),
    false,
  );
});
