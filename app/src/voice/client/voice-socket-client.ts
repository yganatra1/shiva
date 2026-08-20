import type { VoiceAudioFrame } from "../audio-frame.js";
import type {
  ClientVoiceMessage,
  ServerVoiceMessage,
} from "../voice-protocol.js";

export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type VoiceConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface VoiceSocketClientOptions {
  readonly url: string;
  readonly createSocket: (url: string) => SocketLike;
  readonly decodeAudioFrame: (
    data: ArrayBuffer | Uint8Array,
  ) => VoiceAudioFrame | null;
  readonly onStateChange: (state: VoiceConnectionState) => void;
  readonly onControl: (message: ServerVoiceMessage) => void;
  readonly onAudio: (frame: VoiceAudioFrame) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly reconnectDelaysMs?: readonly number[];
}

/**
 * The browser side of the single voice connection.
 *
 * It owns socket lifetime, automatic reconnection, JSON control messages, and
 * binary frame decoding. It deliberately knows nothing about the DOM so it can
 * be tested with a fake socket, and it has no imports so the voice page can
 * embed it with `VoiceSocketClient.toString()`.
 */
export const VoiceSocketClient = (() => class {
  private socket: SocketLike | null = null;
  private state: VoiceConnectionState = "closed";
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;

  constructor(private readonly options: VoiceSocketClientOptions) {}

  connect(): void {
    this.intentionallyClosed = false;
    this.clearReconnectTimer();
    if (this.socket) return;

    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = this.options.createSocket(this.options.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setState("open");
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.receive(event.data);
    };
    socket.onerror = () => {
      // A failed connection always also emits close; reconnect happens there.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.intentionallyClosed) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  send(message: ClientVoiceMessage): boolean {
    const socket = this.socket;
    if (!socket || this.state !== "open") return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  sendAudio(bytes: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || this.state !== "open") return false;
    socket.send(bytes);
    return true;
  }

  close(): void {
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.setState("closed");
    if (socket) socket.close(1000, "client_closed");
  }

  currentState(): VoiceConnectionState {
    return this.state;
  }

  private receive(data: unknown): void {
    if (typeof data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        this.options.onControl(parsed as ServerVoiceMessage);
      }
      return;
    }

    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      const frame = this.options.decodeAudioFrame(data);
      if (frame) this.options.onAudio(frame);
    }
  }

  private scheduleReconnect(): void {
    const delays = this.options.reconnectDelaysMs ?? [
      400, 900, 1_800, 3_500, 7_000,
    ];
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 7_000;
    this.attempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = this.options.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.intentionallyClosed) this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.options.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: VoiceConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange(state);
  }
})();
