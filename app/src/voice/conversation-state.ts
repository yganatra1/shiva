interface SessionStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Remembers the Shiva conversation ID for one browser tab so a reconnect, or a
 * later turn, continues the same conversation instead of starting a new one.
 */
export class VoiceConversationState {
  private conversationId: string | null;

  constructor(
    private readonly storage: SessionStoragePort,
    private readonly storageKey = "shiva.voice.conversationId",
  ) {
    this.conversationId = storage.getItem(storageKey);
  }

  current(): string | null {
    return this.conversationId;
  }

  /** Stores a server-assigned ID; a null value leaves the current one intact. */
  remember(conversationId: string | null | undefined): void {
    if (!conversationId || conversationId === this.conversationId) {
      return;
    }
    this.conversationId = conversationId;
    this.storage.setItem(this.storageKey, conversationId);
  }

  clear(): void {
    this.conversationId = null;
    this.storage.removeItem(this.storageKey);
  }
}
