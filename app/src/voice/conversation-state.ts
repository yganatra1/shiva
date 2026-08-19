interface SessionStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface HeaderReader {
  get(name: string): string | null;
}

export class VoiceConversationState {
  private conversationId: string | null;

  constructor(
    private readonly storage: SessionStoragePort,
    private readonly storageKey = "shiva.voice.conversationId",
  ) {
    this.conversationId = storage.getItem(storageKey);
  }

  chatPayload(message: string): {
    readonly message: string;
    readonly conversationId?: string;
  } {
    return this.conversationId
      ? { message, conversationId: this.conversationId }
      : { message };
  }

  captureResponse(headers: HeaderReader): string | null {
    const conversationId = headers.get("x-shiva-conversation-id");
    if (conversationId) {
      this.conversationId = conversationId;
      this.storage.setItem(this.storageKey, conversationId);
    }
    return this.conversationId;
  }

  clear(): void {
    this.conversationId = null;
    this.storage.removeItem(this.storageKey);
  }

  current(): string | null {
    return this.conversationId;
  }
}
