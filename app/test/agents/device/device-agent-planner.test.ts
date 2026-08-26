import assert from "node:assert/strict";
import { test } from "node:test";

import { ShivaDeviceAgentPlanner } from "../../../src/agents/device/device-agent-planner.js";
import type {
  AIProvider,
  ChatInput,
} from "../../../src/brain/ai-provider.js";

class RecordingProvider implements AIProvider {
  input: ChatInput | undefined;
  inputs: ChatInput[] = [];

  async chat(input: ChatInput) {
    this.input = input;
    this.inputs.push(input);
    return {
      content:
        '{"type":"done","success":true,"summary":"Miralididi has phone number +911234567890."}',
    };
  }

  async *streamChat(): AsyncIterable<{ content: string }> {
    throw new Error("Not used by the device-agent planner.");
  }
}

test("the device planner owns direct phone tasks and receives cancellation", async () => {
  const provider = new RecordingProvider();
  const planner = new ShivaDeviceAgentPlanner(provider);
  const controller = new AbortController();

  const decision = await planner.decide({
    goal: "Find miralididi's phone number.",
    steps: [],
    stepNumber: 1,
    maxSteps: 15,
    signal: controller.signal,
  });

  assert.equal(decision.type, "done");
  assert.equal(provider.input?.signal, controller.signal);
  const systemPrompt = provider.input?.messages[0]?.content ?? "";
  assert.match(systemPrompt, /every Android-phone goal/i);
  assert.match(systemPrompt, /contacts, calls, notifications, SMS, location, camera capture/i);
  assert.match(systemPrompt, /no on-screen UI automation/i);
  assert.doesNotMatch(systemPrompt, /device\.ui\./);
  assert.match(systemPrompt, /include the requested returned facts/i);
  assert.match(systemPrompt, /sole instruction.*authorization boundary/i);
  assert.match(systemPrompt, /screen text.*untrusted data/i);
  assert.match(systemPrompt, /never authorize a new recipient/i);
});

test("camera bytes reach vision without entering the textual planner trace", async () => {
  const provider = new RecordingProvider();
  const traces: Record<string, unknown>[] = [];
  const planner = new ShivaDeviceAgentPlanner(provider, (detail) => {
    traces.push(detail);
  });
  const image = "A".repeat(4_096);

  await planner.decide({
    goal: "Take a photo and describe it.",
    steps: [
      {
        step: 1,
        tool: "device.camera.capture",
        arguments: {},
        result: {
          commandId: "cmd-1",
          status: "COMPLETED",
          result: {
            mime: "image/jpeg",
            encoding: "base64",
            data: image,
          },
        },
      },
    ],
    stepNumber: 2,
    maxSteps: 15,
  });

  const userMessage = provider.input?.messages[1];
  assert.deepEqual(userMessage?.images, [image]);
  assert.doesNotMatch(userMessage?.content ?? "", new RegExp(`A{${image.length}}`));
  assert.match(userMessage?.content ?? "", /base64 image omitted from text/);
  assert.equal(JSON.stringify(traces).includes(image), false);
});
