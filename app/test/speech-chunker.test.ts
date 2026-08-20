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
