import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamingSpeechChunker } from "../src/voice/speech-chunker.js";

test("emits a smaller first chunk and uses larger thresholds afterward", () => {
  const chunker = new StreamingSpeechChunker({
    firstMinChars: 12,
    firstTargetChars: 20,
    subsequentMinChars: 28,
    subsequentTargetChars: 40,
    hardMaxChars: 60,
  });

  assert.deepEqual(chunker.push("Here is the answer."), ["Here is the answer."]);
  assert.deepEqual(chunker.push(" It is short."), []);
  assert.deepEqual(chunker.push(" This second sentence makes it speak."), [
    "It is short. This second sentence makes it speak.",
  ]);
});

test("combines tiny streamed sentences into one useful TTS request", () => {
  const chunker = new StreamingSpeechChunker({
    firstMinChars: 18,
    firstTargetChars: 30,
    subsequentMinChars: 24,
    subsequentTargetChars: 42,
    hardMaxChars: 70,
  });

  assert.deepEqual(chunker.push("Yes."), []);
  assert.deepEqual(chunker.push(" It is."), []);
  assert.deepEqual(chunker.push(" Absolutely."), ["Yes. It is. Absolutely."]);
});

test("handles punctuation and words split across streaming deltas", () => {
  const chunker = new StreamingSpeechChunker({
    firstMinChars: 10,
    firstTargetChars: 20,
    subsequentMinChars: 20,
    subsequentTargetChars: 35,
    hardMaxChars: 60,
  });

  assert.deepEqual(chunker.push("This is stream"), []);
  assert.deepEqual(chunker.push("ing correctly"), []);
  assert.deepEqual(chunker.push("! Next"), ["This is streaming correctly!"]);
  assert.deepEqual(chunker.finish(), ["Next"]);
});

test("uses a clause boundary when punctuation-free text reaches its target", () => {
  const chunker = new StreamingSpeechChunker({
    firstMinChars: 10,
    firstTargetChars: 30,
    subsequentMinChars: 20,
    subsequentTargetChars: 40,
    hardMaxChars: 60,
  });

  assert.deepEqual(
    chunker.push("This opening thought is useful, and the explanation continues"),
    ["This opening thought is useful,"],
  );
  assert.deepEqual(chunker.finish(), ["and the explanation continues"]);
});

test("uses a target word boundary when streamed prose has no punctuation", () => {
  const chunker = new StreamingSpeechChunker({
    firstMinChars: 10,
    firstTargetChars: 30,
    subsequentMinChars: 20,
    subsequentTargetChars: 42,
    hardMaxChars: 70,
  });

  assert.deepEqual(chunker.push("This opening thought keeps"), []);
  assert.deepEqual(
    chunker.push(" flowing naturally without punctuation and continues onward"),
    [
      "This opening thought keeps",
      "flowing naturally without punctuation and",
    ],
  );
  assert.deepEqual(chunker.finish(), ["continues onward"]);
});

test("enforces the hard maximum at a word boundary", () => {
  const chunker = new StreamingSpeechChunker({
    firstMinChars: 10,
    firstTargetChars: 30,
    subsequentMinChars: 20,
    subsequentTargetChars: 40,
    hardMaxChars: 45,
  });
  const prose = `${"x".repeat(46)} remaining words`;

  const chunks = chunker.push(prose);

  assert.equal(chunks.length, 1);
  const firstChunk = chunks[0];
  assert.ok(firstChunk);
  assert.ok(firstChunk.length <= 45);
  assert.equal(firstChunk, "x".repeat(45));
  assert.deepEqual(chunker.finish(), ["x remaining words"]);
});

test("finish emits an incomplete tail exactly once", () => {
  const chunker = new StreamingSpeechChunker();

  assert.deepEqual(chunker.push("A final incomplete thought"), []);
  assert.deepEqual(chunker.finish(), ["A final incomplete thought"]);
  assert.deepEqual(chunker.finish(), []);
  assert.throws(
    () => chunker.push(" stale text"),
    /Cannot push text after finish/,
  );
});

test("default thresholds prioritize a small first phrase then larger later ones", () => {
  const chunker = new StreamingSpeechChunker();
  const answer =
    "India has a huge and young population, which is already reshaping demand. " +
    "That creates enormous economic potential, but it also puts real pressure on " +
    "housing, transport, and public services in the largest cities.";

  const chunks = [...chunker.push(answer), ...chunker.finish()];
  const first = chunks[0] ?? "";
  assert.ok(first.length >= 24 && first.length <= 48, first);
  for (const later of chunks.slice(1, -1)) {
    assert.ok(later.length >= 100 && later.length <= 200, later);
  }
});

test("a long opening sentence does not delay speech past the first target", () => {
  const chunker = new StreamingSpeechChunker();

  const chunks = chunker.push(
    "India has a huge and young population, and that reshapes everything else.",
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "India has a huge and young population,");
});

test("reset discards cancelled text and restores first-chunk behavior", () => {
  const chunker = new StreamingSpeechChunker({
    firstMinChars: 12,
    firstTargetChars: 20,
    subsequentMinChars: 30,
    subsequentTargetChars: 45,
    hardMaxChars: 60,
  });

  assert.deepEqual(chunker.push("This cancelled tail"), []);
  chunker.reset();
  assert.deepEqual(chunker.finish(), []);

  chunker.reset();
  assert.deepEqual(chunker.push("A fresh response."), ["A fresh response."]);
});

test("the class remains self-contained for browser embedding", () => {
  const EmbeddedChunker = Function(
    `"use strict"; return (${StreamingSpeechChunker.toString()});`,
  )() as typeof StreamingSpeechChunker;
  const chunker = new EmbeddedChunker({
    firstMinChars: 10,
    firstTargetChars: 20,
    subsequentMinChars: 20,
    subsequentTargetChars: 35,
    hardMaxChars: 50,
  });

  assert.deepEqual(chunker.push("This can run in a browser."), [
    "This can run in a browser.",
  ]);
});
