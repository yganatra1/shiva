import assert from "node:assert/strict";
import { Script } from "node:vm";
import { test } from "node:test";

import { createVoiceClientScript } from "../src/voice/voice-ui.js";

interface PlaybackEvent {
  readonly event: string;
  readonly sequence?: number;
}

interface HarnessOptions {
  readonly chatText: string;
  readonly autoplay: "complete" | "reject";
  readonly audioContextConstructor?: new () => unknown;
  readonly abortFirstChat?: boolean;
}

test("autoplay fallback preserves every chunk until manual playback completes", async () => {
  const harness = createHarness({
    chatText:
      "This first response sentence is long enough. " +
      "This second response sentence is also long enough.",
    autoplay: "reject",
  });

  harness.submit("Please answer.");
  await waitFor(
    () =>
      harness.ttsCalls() === 2 &&
      harness.status.textContent.includes("Press play"),
  );

  assert.equal(harness.audio.src, "blob:voice-1");
  assert.equal(hasIdle(harness.playbackEvents), false);

  harness.audio.completeManually();
  await waitFor(
    () =>
      harness.audio.src === "blob:voice-2" &&
      harness.status.textContent.includes("Press play"),
  );
  assert.equal(hasIdle(harness.playbackEvents), false);

  harness.audio.completeManually();
  await waitFor(() => hasIdle(harness.playbackEvents));

  assert.deepEqual(
    harness.playbackEvents.map(({ event, sequence }) => [event, sequence]),
    [
      ["scheduled", 0],
      ["started", 0],
      ["ended", 0],
      ["scheduled", 1],
      ["started", 1],
      ["ended", 1],
      ["idle", undefined],
    ],
  );
  assert.equal(harness.status.textContent, "Ready");
});

test("a Web Audio start failure rolls back and keeps the turn on fallback", async () => {
  let decodeCalls = 0;
  let sourceStartCalls = 0;

  class FailingStartAudioContext {
    readonly state = "running";
    readonly currentTime = 1;
    readonly destination = {};

    async resume(): Promise<void> {}

    async decodeAudioData(): Promise<{
      readonly numberOfChannels: number;
      readonly sampleRate: number;
      getChannelData(): Float32Array;
    }> {
      decodeCalls += 1;
      const samples = new Float32Array(1_000);
      samples.fill(0.1);
      return {
        numberOfChannels: 1,
        sampleRate: 1_000,
        getChannelData: () => samples,
      };
    }

    createBufferSource(): FakeBufferSource {
      return new FakeBufferSource(() => {
        sourceStartCalls += 1;
        throw new Error("Synthetic Web Audio start failure.");
      });
    }
  }

  const harness = createHarness({
    chatText:
      "This first response sentence is long enough. " +
      "This second response sentence is also long enough.",
    autoplay: "complete",
    audioContextConstructor: FailingStartAudioContext,
  });

  harness.submit("Please answer.");
  await waitFor(() => hasIdle(harness.playbackEvents));

  assert.equal(harness.ttsCalls(), 2);
  assert.equal(sourceStartCalls, 1);
  assert.equal(
    decodeCalls,
    1,
    "later chunks must remain on fallback after Web Audio fails",
  );
});

test("an aborted stale chat cannot overwrite the current turn status", async () => {
  const harness = createHarness({
    chatText: "The current response is complete and ready to speak.",
    autoplay: "complete",
    abortFirstChat: true,
  });

  harness.submit("Old request");
  harness.submit("Current request");

  await waitFor(() => harness.response.textContent.includes("current response"));
  await waitFor(() => hasIdle(harness.playbackEvents));

  assert.equal(
    harness.status.history.some((message) => /abort/i.test(message)),
    false,
  );
  assert.equal(harness.status.textContent, "Ready");
});

class FakeBufferSource {
  buffer: unknown;

  constructor(private readonly startImplementation: () => void) {}

  connect(): void {}

  disconnect(): void {}

  addEventListener(): void {}

  start(): void {
    this.startImplementation();
  }

  stop(): void {}
}

interface Listener {
  readonly callback: (event: unknown) => void;
  readonly once: boolean;
}

class FakeElement {
  readonly classList = {
    add: (_name: string) => undefined,
    remove: (_name: string) => undefined,
    toggle: (_name: string, _force?: boolean) => false,
  };
  readonly history: string[] = [];
  hidden = false;
  value = "";
  private copy = "";
  private readonly listeners = new Map<string, Listener[]>();

  get textContent(): string {
    return this.copy;
  }

  set textContent(value: string) {
    this.copy = value;
    this.history.push(value);
  }

  addEventListener(
    event: string,
    callback: (payload: unknown) => void,
    options?: { readonly once?: boolean },
  ): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push({ callback, once: options?.once ?? false });
    this.listeners.set(event, listeners);
  }

  removeEventListener(
    event: string,
    callback: (payload: unknown) => void,
  ): void {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      listeners.filter((listener) => listener.callback !== callback),
    );
  }

  emit(event: string, payload: unknown = {}): void {
    const listeners = [...(this.listeners.get(event) ?? [])];
    for (const listener of listeners) {
      listener.callback(payload);
      if (listener.once) this.removeEventListener(event, listener.callback);
    }
  }

  setPointerCapture(): void {}
}

class FakeAudioElement extends FakeElement {
  ended = false;
  private source = "";

  constructor(private readonly autoplay: "complete" | "reject") {
    super();
  }

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    this.ended = false;
  }

  play(): Promise<void> {
    if (this.autoplay === "reject") {
      return Promise.reject(new Error("Autoplay is blocked."));
    }
    queueMicrotask(() => this.completeManually());
    return Promise.resolve();
  }

  completeManually(): void {
    this.emit("playing");
    this.ended = true;
    this.emit("ended");
  }

  pause(): void {
    this.emit("pause");
  }

  removeAttribute(name: string): void {
    if (name === "src") this.source = "";
  }

  load(): void {}
}

function createHarness(options: HarnessOptions): {
  readonly audio: FakeAudioElement;
  readonly playbackEvents: PlaybackEvent[];
  readonly response: FakeElement;
  readonly status: FakeElement;
  submit(message: string): void;
  ttsCalls(): number;
} {
  const elements = new Map<string, FakeElement>();
  const audio = new FakeAudioElement(options.autoplay);
  elements.set("audio", audio);
  for (const id of [
    "mic",
    "status",
    "transcription",
    "response",
    "typedForm",
    "typedInput",
    "stopSpeaking",
    "newConversation",
  ]) {
    elements.set(id, new FakeElement());
  }

  const playbackEvents: PlaybackEvent[] = [];
  let synthesisCalls = 0;
  let chatCalls = 0;
  let objectUrlSequence = 0;
  const storage = new Map<string, string>();

  const fetchImplementation = async (
    input: unknown,
    init?: { readonly body?: unknown; readonly signal?: AbortSignal },
  ): Promise<Response> => {
    const path = String(input);
    if (path === "/voice/chat") {
      chatCalls += 1;
      if (options.abortFirstChat && chatCalls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () =>
            reject(new DOMException("The operation was aborted.", "AbortError"));
          if (init?.signal?.aborted) {
            rejectAbort();
          } else {
            init?.signal?.addEventListener("abort", rejectAbort, { once: true });
          }
        });
      }
      return new Response(options.chatText, {
        headers: {
          "x-shiva-conversation-id":
            "30000000-0000-4000-8000-000000000003",
        },
      });
    }
    if (path === "/voice/synthesize") {
      synthesisCalls += 1;
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (path === "/voice/playback") {
      playbackEvents.push(JSON.parse(String(init?.body)) as PlaybackEvent);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected test fetch: ${path}`);
  };

  const windowObject: Record<string, unknown> = {
    AudioContext: options.audioContextConstructor,
    webkitAudioContext: undefined,
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
  };
  const context = {
    AbortController,
    Blob,
    DOMException,
    Promise,
    Response,
    TextDecoder,
    URL: {
      createObjectURL: () => `blob:voice-${++objectUrlSequence}`,
      revokeObjectURL: (_url: string) => undefined,
    },
    console: { warn: () => undefined },
    crypto: {
      randomUUID: () => "40000000-0000-4000-8000-000000000004",
    },
    document: {
      getElementById: (id: string) => elements.get(id),
    },
    fetch: fetchImplementation,
    navigator: {},
    queueMicrotask,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    setTimeout,
    clearTimeout,
    window: windowObject,
  };

  new Script(createVoiceClientScript()).runInNewContext(context);

  const typedForm = requiredElement(elements, "typedForm");
  const typedInput = requiredElement(elements, "typedInput");
  return {
    audio,
    playbackEvents,
    response: requiredElement(elements, "response"),
    status: requiredElement(elements, "status"),
    submit: (message: string) => {
      typedInput.value = message;
      typedForm.emit("submit", { preventDefault: () => undefined });
    },
    ttsCalls: () => synthesisCalls,
  };
}

function requiredElement(
  elements: ReadonlyMap<string, FakeElement>,
  id: string,
): FakeElement {
  const element = elements.get(id);
  assert.ok(element, `Missing fake element: ${id}`);
  return element;
}

function hasIdle(events: readonly PlaybackEvent[]): boolean {
  return events.some((event) => event.event === "idle");
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for browser voice state.");
}
