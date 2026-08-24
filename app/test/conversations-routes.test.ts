import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import { defaultConversationTitle } from "../src/services/chat-service.js";
import {
  createTestOverrides,
  InMemoryRepository,
  testConfig,
} from "./test-support.js";

const provider: AIProvider = {
  async chat() {
    return { content: '{"memories":[]}' };
  },
  async *streamChat() {
    yield { content: "Shiva reply" };
  },
};

function setup() {
  const repository = new InMemoryRepository();
  const app = createApp(
    testConfig,
    createTestOverrides(provider, repository),
  );
  return { app, repository };
}

test("automatic conversation titles are concise and handle image-only chats", () => {
  assert.equal(
    defaultConversationTitle("  Plan   a trip \n to Jaipur  "),
    "Plan a trip to Jaipur",
  );
  assert.equal(defaultConversationTitle("", 1), "Photo");
  assert.equal(defaultConversationTitle("", 3), "3 photos");
  const long = defaultConversationTitle("x".repeat(200));
  assert.equal(long.length, 80);
  assert.match(long, /…$/u);
});

async function createConversation(
  app: ReturnType<typeof createApp>,
  message: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message },
  });
  assert.equal(response.statusCode, 200);
  const id = response.headers["x-shiva-conversation-id"];
  assert.equal(typeof id, "string");
  return String(id);
}

test("conversation list is empty before the first chat", async (context) => {
  const { app } = setup();
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/conversations",
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["cache-control"] ?? "", /no-store/);
  assert.deepEqual(response.json(), {
    conversations: [],
    nextCursor: null,
  });
});

test("chat creates an automatic title and history API returns ordered messages", async (context) => {
  const { app } = setup();
  context.after(() => app.close());
  const conversationId = await createConversation(
    app,
    "Plan a weekend in Udaipur",
  );

  const list = await app.inject({
    method: "GET",
    url: "/api/conversations",
  });
  assert.equal(list.statusCode, 200);
  const [conversation] = list.json().conversations;
  assert.equal(conversation.id, conversationId);
  assert.equal(conversation.title, "Plan a weekend in Udaipur");
  assert.equal(conversation.messageCount, 2);

  const history = await app.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/messages`,
  });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().conversation.id, conversationId);
  assert.deepEqual(
    history.json().messages.map(
      (message: { readonly role: string; readonly content: string }) => [
        message.role,
        message.content,
      ],
    ),
    [
      ["user", "Plan a weekend in Udaipur"],
      ["assistant", "Shiva reply"],
    ],
  );
  assert.equal(history.json().nextCursor, null);
});

test("conversation list and message history use opaque cursor pagination", async (context) => {
  const { app } = setup();
  context.after(() => app.close());
  const firstId = await createConversation(app, "First topic");
  const secondId = await createConversation(app, "Second topic");

  const firstPage = await app.inject({
    method: "GET",
    url: "/api/conversations?limit=1",
  });
  assert.equal(firstPage.statusCode, 200);
  assert.equal(firstPage.json().conversations.length, 1);
  assert.equal(firstPage.json().conversations[0].id, secondId);
  assert.equal(typeof firstPage.json().nextCursor, "string");

  const secondPage = await app.inject({
    method: "GET",
    url: `/api/conversations?limit=1&cursor=${encodeURIComponent(
      firstPage.json().nextCursor,
    )}`,
  });
  assert.equal(secondPage.statusCode, 200);
  assert.equal(secondPage.json().conversations[0].id, firstId);
  assert.equal(secondPage.json().nextCursor, null);

  const latestMessage = await app.inject({
    method: "GET",
    url: `/api/conversations/${firstId}/messages?limit=1`,
  });
  assert.equal(latestMessage.statusCode, 200);
  assert.equal(latestMessage.json().messages[0].role, "assistant");
  assert.equal(typeof latestMessage.json().nextCursor, "string");

  const olderMessage = await app.inject({
    method: "GET",
    url: `/api/conversations/${firstId}/messages?limit=1&cursor=${encodeURIComponent(
      latestMessage.json().nextCursor,
    )}`,
  });
  assert.equal(olderMessage.statusCode, 200);
  assert.equal(olderMessage.json().messages[0].role, "user");
  assert.equal(olderMessage.json().nextCursor, null);
});

test("rename is persistent and later chat turns do not overwrite it", async (context) => {
  const { app } = setup();
  context.after(() => app.close());
  const conversationId = await createConversation(app, "Initial title");

  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/conversations/${conversationId}`,
    headers: { "content-type": "application/json" },
    payload: { title: "Rajasthan plans" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().conversation.title, "Rajasthan plans");

  const continued = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Add one more day", conversationId },
  });
  assert.equal(continued.statusCode, 200);

  const list = await app.inject({
    method: "GET",
    url: "/api/conversations",
  });
  assert.equal(list.json().conversations[0].title, "Rajasthan plans");
  assert.equal(list.json().conversations[0].messageCount, 4);
});

test("delete removes the conversation and its messages", async (context) => {
  const { app } = setup();
  context.after(() => app.close());
  const conversationId = await createConversation(app, "Delete me");

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/conversations/${conversationId}`,
  });
  assert.equal(deleted.statusCode, 204);

  const history = await app.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/messages`,
  });
  assert.equal(history.statusCode, 404);
  assert.equal(history.json().error.code, "CONVERSATION_NOT_FOUND");
});

test("conversation APIs reject invalid input and hide other users' conversations", async (context) => {
  const { app, repository } = setup();
  context.after(() => app.close());
  const conversationId = await createConversation(app, "Keep");
  const foreign = await repository.resolveConversation(
    "10000000-0000-4000-8000-000000000001",
  );

  const invalidCursor = await app.inject({
    method: "GET",
    url: "/api/conversations?cursor=not-a-cursor",
  });
  assert.equal(invalidCursor.statusCode, 400);
  assert.equal(invalidCursor.json().error.code, "INVALID_CURSOR");

  const invalidTitle = await app.inject({
    method: "PATCH",
    url: `/api/conversations/${conversationId}`,
    headers: { "content-type": "application/json" },
    payload: { title: "   " },
  });
  assert.equal(invalidTitle.statusCode, 400);
  assert.equal(invalidTitle.json().error.code, "INVALID_CONVERSATION_TITLE");

  const wrongContentType = await app.inject({
    method: "PATCH",
    url: `/api/conversations/${conversationId}`,
    headers: { "content-type": "text/plain" },
    payload: "rename",
  });
  assert.equal(wrongContentType.statusCode, 415);

  const foreignHistory = await app.inject({
    method: "GET",
    url: `/api/conversations/${foreign.id}/messages`,
  });
  assert.equal(foreignHistory.statusCode, 404);

  const foreignRename = await app.inject({
    method: "PATCH",
    url: `/api/conversations/${foreign.id}`,
    headers: { "content-type": "application/json" },
    payload: { title: "No access" },
  });
  assert.equal(foreignRename.statusCode, 404);
});
