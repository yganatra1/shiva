import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AIProvider,
  ChatInput,
} from "../src/brain/ai-provider.js";
import { MemoryExtractor } from "../src/memory/memory-extractor.js";

test("explicit extraction audits a compound statement for omitted atomic meanings", async () => {
  const inputs: ChatInput[] = [];
  const responses = [
    {
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "relationship",
          content: "Charmi is Yash's wife.",
          importance: 0.9,
          confidence: 0.98,
        },
      ],
    },
    {
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "preference",
          content: "Yash loves travelling with his wife Charmi.",
          importance: 0.9,
          confidence: 0.97,
        },
      ],
    },
  ];
  const provider: AIProvider = {
    async chat(input) {
      inputs.push(input);
      const response = responses.shift();
      assert.ok(response);
      return { content: JSON.stringify(response) };
    },
    async *streamChat() {
      throw new Error("Extraction must use non-streaming structured output.");
    },
  };
  const extractor = new MemoryExtractor(provider);

  const memories = await extractor.extract({
    userMessage: "Remember that I love travelling with my Wife Charmi",
    assistantResponse: "",
    recentMessages: [],
    explicitRequest: true,
  });

  assert.deepEqual(
    memories.map((memory) => [memory.semanticType, memory.content]),
    [
      ["relationship", "Charmi is Yash's wife."],
      ["preference", "Yash loves travelling with his wife Charmi."],
    ],
  );
  assert.equal(inputs.length, 2);
  assert.match(inputs[1]?.messages[0]?.content ?? "", /omitted durable meanings/i);
  assert.match(
    inputs[1]?.messages[1]?.content ?? "",
    /Remember that I love travelling with my Wife Charmi/,
  );
});

test("correction audit replaces a merged old preference with only the current value", async () => {
  const inputs: ChatInput[] = [];
  const responses = [
    {
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "preference",
          content: "The user's favorite colors are blue and black.",
          importance: 1,
          confidence: 1,
        },
      ],
    },
    {
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "preference",
          content: "Yash's favourite colour is only blue.",
          importance: 1,
          confidence: 1,
        },
      ],
    },
  ];
  const provider: AIProvider = {
    async chat(input) {
      inputs.push(input);
      const response = responses.shift();
      assert.ok(response);
      return { content: JSON.stringify(response) };
    },
    async *streamChat() {
      throw new Error("Extraction must use non-streaming structured output.");
    },
  };
  const extractor = new MemoryExtractor(provider);

  const memories = await extractor.extract({
    userMessage:
      "Now I am thinking my favourite color is Blue Actually only Blue",
    assistantResponse: "",
    recentMessages: [],
  });

  assert.deepEqual(
    memories.map((memory) => memory.content),
    ["Yash's favourite colour is only blue."],
  );
  assert.equal(inputs.length, 2);
  assert.match(inputs[1]?.messages[0]?.content ?? "", /authoritative/i);
  assert.doesNotMatch(memories[0]?.content ?? "", /black/i);
});
