import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";

import {
  createPeopleClientScript,
  createPeoplePage,
} from "../src/people/people-ui";

test("People client script parses and uses resumable per-photo uploads", () => {
  const script = createPeopleClientScript();

  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /Promise\.all\(\[worker\(\), worker\(\)\]\)/);
  assert.match(script, /const pending = state\.files\.filter/);
  assert.match(script, /while \(cursor < pending\.length\)/);
  assert.match(script, /\/api\/people\/.*\/faces/);
  assert.match(script, /entry\.status = "rejected"/);
  assert.match(script, /loadPeople\(state\.activeId, true\)/);
  assert.match(script, /if \(!preserveFiles\) clearFiles\(\)/);
  assert.match(script, /createImageBitmap/);
  assert.match(script, /const image = new Image\(\)/);
  assert.match(script, /1600/);
});

test("People client protects queued work and exposes explicit retry and deletion", () => {
  const script = createPeopleClientScript();

  assert.match(script, /function hasNavigationRisk\(\)/);
  assert.match(script, /window\.confirm\("Discard unsaved profile changes and queued photos\?"\)/);
  assert.match(script, /card\.disabled = state\.busy/);
  assert.match(script, /photos\.disabled = busy/);
  assert.match(script, /link\.classList\.toggle\("locked", busy\)/);
  assert.match(script, /function retryEntry\(entry\)/);
  assert.match(script, /photos\.value = ""/);
  assert.match(script, /entry\.faceSampleId = body\.faceSample/);
  assert.match(script, /method: "DELETE"/);
  assert.match(script, /\/api\/people\/" \+ encodeURIComponent\(id\)/);
  assert.doesNotMatch(script, /x-shiva-file-name/i);
});

test("People client rejects malformed and duplicate detail keys before saving", () => {
  const script = createPeopleClientScript();

  assert.match(script, /must use key: value/);
  assert.match(script, /repeats the key/);
  assert.match(script, /payload = personPayload\(\)/);
  assert.match(script, /byId\("details"\)\.focus\(\)/);
});

test("People page keeps selection local and recommends varied photos", () => {
  const page = createPeoplePage();

  assert.match(page, /multiple/);
  assert.match(page, /10–15 or more varied photos/i);
  assert.match(page, /private Shiva face service/i);
  assert.match(page, /Originals stay in this browser/i);
  assert.match(page, /no original or resized image file is retained/i);
  assert.match(page, /Enrolled face samples/i);
  assert.match(page, /Clear local queue/i);
  assert.doesNotMatch(page, /embedding vector|imageSha256/);
});
