export type VoiceService = "asr" | "tts";

export type VoiceProviderFailure =
  | "CANCELLED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_AUDIO"
  | "INVALID_RESPONSE";

export class VoiceProviderError extends Error {
  override readonly name = "VoiceProviderError";

  constructor(
    readonly service: VoiceService,
    readonly failure: VoiceProviderFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface TranscriptionResult {
  readonly text: string;
  readonly language: string;
}

export interface ASRInput {
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
  readonly signal?: AbortSignal;
}

export interface ASRProvider {
  transcribe(input: ASRInput): Promise<TranscriptionResult>;
}

export interface SynthesisInput {
  readonly text: string;
  readonly signal?: AbortSignal;
}

export interface SynthesisResult {
  readonly audio: Uint8Array;
  readonly contentType: "audio/wav";
}

export interface TTSProvider {
  synthesize(input: SynthesisInput): Promise<SynthesisResult>;
}
