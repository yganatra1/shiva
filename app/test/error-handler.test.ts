import assert from "node:assert/strict";
import { test } from "node:test";

import { safeErrorLogMetadata } from "../src/api/error-handler";

test("safe error logging excludes database queries and biometric parameters", () => {
  const embeddingSentinel = "0.123456789,0.987654321";
  const cause = Object.assign(
    new Error(`column reference is ambiguous: ${embeddingSentinel}`),
    {
      code: "42702",
      query: "select embedding from person_face_embeddings",
      params: [embeddingSentinel],
    },
  );
  const error = Object.assign(
    new Error(`Failed query with params ${embeddingSentinel}`, { cause }),
    {
      query: cause.query,
      params: cause.params,
    },
  );

  const metadata = safeErrorLogMetadata(error);

  assert.deepEqual(metadata, {
    errorType: "Error",
    errorCode: undefined,
    causeType: "Error",
    causeCode: "42702",
  });
  assert.doesNotMatch(JSON.stringify(metadata), /embedding|0\.123456789/);
});
