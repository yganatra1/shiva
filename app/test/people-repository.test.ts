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

test("searchPeople also compares whitespace-stripped forms for a loose name match", async () => {
  let queryText = "";
  let params: unknown[] = [];
  const client = {
    async query(query: { readonly text: string }, values: unknown[]) {
      queryText = query.text;
      params = values;
      return { rows: [] };
    },
  };
  const database = drizzle(client as never, { schema }) as ShivaDatabase;
  const repository = new DrizzlePeopleRepository(database);

  await repository.searchPeople(
    "00000000-0000-4000-8000-000000000001",
    "miralididi",
  );

  // Two extra OR'd clauses beyond the existing five: display name and alias
  // compared after stripping all whitespace from both sides.
  assert.match(
    queryText,
    /regexp_replace\(lower\(coalesce\("people"\."display_name", ''\)\), '\\s\+', '', 'g'\)/,
  );
  assert.match(
    queryText,
    /regexp_replace\("person_aliases"\."normalized_alias", '\\s\+', '', 'g'\)/,
  );
  // The query parameter itself must be fully stripped too ("mirali didi" ->
  // "miralididi"), not just lowercased/collapsed.
  assert.ok(params.includes("miralididi"));
});
