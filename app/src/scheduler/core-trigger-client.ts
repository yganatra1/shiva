import { z } from "zod";

import type {
  ScheduledCoreTriggerRequest,
  ScheduledCoreTriggerResponse,
} from "./scheduler-types";

const responseSchema = z
  .object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    executionId: z.string().uuid(),
    conversationId: z.string().uuid(),
    response: z.string(),
  })
  .strict();

export class CoreTriggerTransientError extends Error {
  override readonly name = "CoreTriggerTransientError";
}

export class CoreTriggerPermanentError extends Error {
  override readonly name = "CoreTriggerPermanentError";
}

export interface ScheduledCoreClient {
  trigger(
    request: ScheduledCoreTriggerRequest,
    signal?: AbortSignal,
  ): Promise<ScheduledCoreTriggerResponse>;
}

export interface HttpScheduledCoreClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
}

export class HttpScheduledCoreClient implements ScheduledCoreClient {
  private readonly endpoint: URL;

  constructor(private readonly options: HttpScheduledCoreClientOptions) {
    this.endpoint = new URL("/internal/scheduler/execute", options.baseUrl);
  }

  async trigger(
    request: ScheduledCoreTriggerRequest,
    signal?: AbortSignal,
  ): Promise<ScheduledCoreTriggerResponse> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: combinedSignal,
      });
    } catch (error: unknown) {
      throw new CoreTriggerTransientError(
        "Shiva Core is temporarily unreachable.",
        { cause: error },
      );
    }

    if (!response.ok) {
      const message = `Shiva Core rejected the scheduled trigger with HTTP ${response.status}.`;
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new CoreTriggerTransientError(message);
      }
      throw new CoreTriggerPermanentError(message);
    }
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch (error: unknown) {
      throw new CoreTriggerTransientError(
        "Shiva Core returned an unreadable scheduler response.",
        { cause: error },
      );
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new CoreTriggerTransientError(
        "Shiva Core returned an invalid scheduler response.",
      );
    }
    return parsed.data;
  }
}
