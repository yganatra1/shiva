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
  private lastCoreUpdateMessageId: string | null;

  constructor(
    private readonly storage: SessionStoragePort,
    private readonly storageKey = "shiva.voice.conversationId",
    private readonly updateCursorStorageKey =
      "shiva.voice.lastCoreUpdateMessageId",
  ) {
    this.conversationId = storage.getItem(storageKey);
    this.lastCoreUpdateMessageId = this.conversationId
      ? storage.getItem(updateCursorStorageKey)
      : null;
  }

  current(): string | null {
    return this.conversationId;
  }

  updateCursor(): string | null {
    return this.lastCoreUpdateMessageId;
  }

  /** Stores a server-assigned ID; a null value leaves the current one intact. */
  remember(conversationId: string | null | undefined): void {
    if (!conversationId || conversationId === this.conversationId) {
      return;
    }
    this.conversationId = conversationId;
    this.lastCoreUpdateMessageId = null;
    this.storage.setItem(this.storageKey, conversationId);
    this.storage.removeItem(this.updateCursorStorageKey);
  }

  /** Advances replay only for the conversation currently owned by this tab. */
  rememberCoreUpdate(conversationId: string, messageId: string): void {
    if (
      conversationId !== this.conversationId ||
      !messageId ||
      messageId === this.lastCoreUpdateMessageId
    ) {
      return;
    }
    this.lastCoreUpdateMessageId = messageId;
    this.storage.setItem(this.updateCursorStorageKey, messageId);
  }

  clear(): void {
    this.conversationId = null;
    this.lastCoreUpdateMessageId = null;
    this.storage.removeItem(this.storageKey);
    this.storage.removeItem(this.updateCursorStorageKey);
  }
}
