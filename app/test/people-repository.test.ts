import assert from "node:assert/strict";
import { test } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";

import type { ShivaDatabase } from "../src/database/pool";
import * as schema from "../src/database/schema";
import { DrizzlePeopleRepository } from "../src/people/people-repository";

test("nearest-face query gives joined ids distinct subquery aliases", async () => {
  let queryText = "";
  const client = {
    async query(query: { readonly text: string }) {
      queryText = query.text;
      return { rows: [] };
    },
  };
  const database = drizzle(client as never, { schema }) as ShivaDatabase;
  const repository = new DrizzlePeopleRepository(database);
  const embedding = Array<number>(512).fill(0);
  embedding[0] = 1;

  const candidates = await repository.findNearestFaceCandidates({
    userId: "00000000-0000-4000-8000-000000000001",
    embedding,
    model: "buffalo_l",
    limit: 40,
  });

  assert.deepEqual(candidates, []);
  assert.match(
    queryText,
    /"person_face_embeddings"\."id" as "sample_id"/,
  );
  assert.match(queryText, /"people"\."id" as "person_id"/);
  assert.doesNotMatch(queryText, /^select "id", "id"/);
});
