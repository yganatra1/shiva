import { z } from "zod";

import {
  VoiceProviderError,
  type ASRInput,
  type ASRProvider,
  type TranscriptionResult,
} from "./provider";

interface HttpASRProviderOptions {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}

const transcriptionSchema = z
  .object({
    text: z.string().trim().min(1),
    language: z.string().trim().min(1),
  })
  .strict();

export class HttpASRProvider implements ASRProvider {
  private readonly endpoint: URL;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HttpASRProviderOptions) {
    this.endpoint = new URL("/transcribe", options.baseUrl);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async transcribe(input: ASRInput): Promise<TranscriptionResult> {
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
      const body = new FormData();
      body.append(
        "file",
        new Blob([input.audio], { type: input.contentType }),
        input.filename,
      );
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: { accept: "application/json" },
        body,
        signal,
      });

      if (!response.ok) {
        await discardResponseBody(response);
        throw new VoiceProviderError(
          "asr",
          [400, 413, 415, 422].includes(response.status)
            ? "INVALID_AUDIO"
            : "UNAVAILABLE",
          `ASR returned HTTP status ${response.status}.`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error: unknown) {
        throw new VoiceProviderError(
          "asr",
          "INVALID_RESPONSE",
          "ASR returned malformed JSON.",
          { cause: error },
        );
      }

      const parsed = transcriptionSchema.safeParse(payload);
      if (!parsed.success) {
        throw new VoiceProviderError(
          "asr",
          "INVALID_RESPONSE",
          "ASR returned an unexpected response shape.",
        );
      }

      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof VoiceProviderError) {
        throw error;
      }
      if (deadlineController.signal.aborted) {
        throw new VoiceProviderError(
          "asr",
          "TIMEOUT",
          `ASR did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      if (input.signal?.aborted) {
        throw new VoiceProviderError(
          "asr",
          "CANCELLED",
          "The client cancelled the ASR request.",
          { cause: error },
        );
      }
      throw new VoiceProviderError(
        "asr",
        "UNAVAILABLE",
        "The ASR request could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the classified upstream status.
  }
}
