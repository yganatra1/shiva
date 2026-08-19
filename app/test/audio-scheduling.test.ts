import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findAudibleWindow,
  planAudioPlayback,
} from "../src/voice/audio-scheduling.js";

test("audio buffers are scheduled continuously when the next clip is ready", () => {
  const first = planAudioPlayback(10, null, 2);
  const second = planAudioPlayback(10.5, first.endAt, 3);

  assert.equal(first.startAt, 10.04);
  assert.equal(second.startAt, first.endAt - 0.018);
  assert.equal(second.underrunMs, 0);
});

test("late audio reports the playback underrun without overlapping old audio", () => {
  const plan = planAudioPlayback(14, 12.5, 2);

  assert.equal(plan.startAt, 14.04);
  assert.ok(Math.abs(plan.underrunMs - 1_540) < 0.001);
});

test("audible window removes only silent edges and preserves padding", () => {
  const channel = new Float32Array(1_000);
  channel.fill(0.1, 300, 700);

  const window = findAudibleWindow([channel], 1_000, 0.0015, 0.02);

  assert.equal(window.offsetSeconds, 0.28);
  assert.equal(window.durationSeconds, 0.44);
});

test("fully silent audio remains intact instead of becoming empty", () => {
  const window = findAudibleWindow([new Float32Array(240)], 24_000);

  assert.equal(window.offsetSeconds, 0);
  assert.equal(window.durationSeconds, 0.01);
});
