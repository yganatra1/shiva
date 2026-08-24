import type { AgentTaskDispatcher } from "../agents/agent-task-dispatcher";
import type { OrchestrationRepositoryPort } from "../agents/orchestration-repository";
import {
  timeoutAgentResponse,
  type CoreAgentResponseProcessor,
} from "./agent-response-processor";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 100;

export interface AgentReliabilitySupervisorOptions {
  readonly dispatcher: Pick<AgentTaskDispatcher, "flushUnpublished">;
  readonly repository: Pick<
    OrchestrationRepositoryPort,
    "listExpiredTasks"
  >;
  readonly responses: Pick<
    CoreAgentResponseProcessor,
    "processResponse" | "recoverUnprocessed"
  >;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

/** Recovers the PostgreSQL outbox and resolves tasks that exceed a deadline. */
export class AgentReliabilitySupervisor {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> = Promise.resolve();
  private runScheduled = false;

  constructor(private readonly options: AgentReliabilitySupervisorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 250) {
      throw new RangeError("Agent reliability interval must be at least 250ms.");
    }
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.scheduleRun();
    this.timer = setInterval(() => this.scheduleRun(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeRun;
  }

  async runOnce(): Promise<void> {
    await this.options.responses.recoverUnprocessed(DEFAULT_BATCH_SIZE);
    const now = this.now();
    const expired = await this.options.repository.listExpiredTasks(
      now,
      DEFAULT_BATCH_SIZE,
    );
    for (const task of expired) {
      await this.options.responses.processResponse(
        timeoutAgentResponse(task, now),
        `deadline:${task.id}`,
        Number.MAX_SAFE_INTEGER,
      );
    }
    await this.options.dispatcher.flushUnpublished(DEFAULT_BATCH_SIZE);
    await this.options.responses.recoverUnprocessed(DEFAULT_BATCH_SIZE);
  }

  private scheduleRun(): void {
    if (this.runScheduled) return;
    this.runScheduled = true;
    this.activeRun = this.runOnce()
      .catch((error: unknown) => this.onError(error))
      .finally(() => {
        this.runScheduled = false;
      });
  }
}
