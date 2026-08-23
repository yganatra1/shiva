import {
  VoiceProviderError,
  type SynthesisInput,
  type SynthesisResult,
  type TTSProvider,
} from "./provider";

interface HttpTTSProviderOptions {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}

const MAX_SYNTHESIZED_AUDIO_BYTES = 25 * 1024 * 1024;

export class HttpTTSProvider implements TTSProvider {
  private readonly endpoint: URL;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HttpTTSProviderOptions) {
    this.endpoint = new URL("/synthesize", options.baseUrl);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const deadlineController = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([deadlineController.signal, input.signal])
      : deadlineController.signal;
    const timeout = setTimeout(
      () => deadlineController.abort(),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          accept: "audio/wav",
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: input.text }),
        signal,
      });

      if (!response.ok) {
        await discardResponseBody(response);
        throw new VoiceProviderError(
          "tts",
          "UNAVAILABLE",
          `TTS returned HTTP status ${response.status}.`,
        );
      }

      if (!isWaveContentType(response.headers.get("content-type"))) {
        await discardResponseBody(response);
        throw new VoiceProviderError(
          "tts",
          "INVALID_RESPONSE",
          "TTS returned a non-WAV response.",
        );
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_SYNTHESIZED_AUDIO_BYTES
      ) {
        await discardResponseBody(response);
        throw new VoiceProviderError(
          "tts",
          "INVALID_RESPONSE",
          "TTS returned an oversized audio response.",
        );
      }

      const audio = new Uint8Array(await response.arrayBuffer());
      if (
        audio.byteLength === 0 ||
        audio.byteLength > MAX_SYNTHESIZED_AUDIO_BYTES ||
        !hasWaveHeader(audio)
      ) {
        throw new VoiceProviderError(
          "tts",
          "INVALID_RESPONSE",
          "TTS returned invalid WAV audio.",
        );
      }

      return { audio, contentType: "audio/wav" };
    } catch (error: unknown) {
      if (error instanceof VoiceProviderError) {
        throw error;
      }
      if (deadlineController.signal.aborted) {
        throw new VoiceProviderError(
          "tts",
          "TIMEOUT",
          `TTS did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      if (input.signal?.aborted) {
        throw new VoiceProviderError(
          "tts",
          "CANCELLED",
          "The client cancelled the TTS request.",
          { cause: error },
        );
      }
      throw new VoiceProviderError(
        "tts",
        "UNAVAILABLE",
        "The TTS request could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isWaveContentType(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "audio/wav";
}

function hasWaveHeader(audio: Uint8Array): boolean {
  return (
    audio.byteLength >= 12 &&
    new TextDecoder("ascii").decode(audio.subarray(0, 4)) === "RIFF" &&
    new TextDecoder("ascii").decode(audio.subarray(8, 12)) === "WAVE"
  );
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the classified upstream status.
  }
}
