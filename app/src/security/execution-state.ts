import { and, eq, sql } from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool.js";
import { systemSettings } from "../database/schema.js";
import {
  compareExecutionModes,
  effectiveExecutionMode,
  type ExecutionMode,
  type ExecutionState,
  type StoredExecutionState,
} from "./execution-mode.js";

const SETTINGS_KEY = "global";
const DEFAULT_STATE: StoredExecutionState = {
  executionMode: "AUTO",
  lockdown: false,
  revision: 0,
  updatedAt: new Date(0),
  updatedBy: null,
};

export interface ExecutionStateUpdate {
  readonly executionMode?: ExecutionMode;
  readonly lockdown?: boolean;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

export interface ExecutionStateStore {
  get(): Promise<StoredExecutionState>;
  update(
    input: ExecutionStateUpdate,
    expectedRevision: number,
  ): Promise<StoredExecutionState | undefined>;
}

export class DrizzleExecutionStateStore implements ExecutionStateStore {
  constructor(private readonly db: ShivaDatabase) {}

  async get(): Promise<StoredExecutionState> {
    await this.db
      .insert(systemSettings)
      .values({ key: SETTINGS_KEY })
      .onConflictDoNothing();
    const [state] = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTINGS_KEY))
      .limit(1);
    if (!state) {
      throw new Error("The global execution settings row is unavailable.");
    }
    return state;
  }

  async update(
    input: ExecutionStateUpdate,
    expectedRevision: number,
  ): Promise<StoredExecutionState | undefined> {
    await this.get();
    const [state] = await this.db
      .update(systemSettings)
      .set({
        ...(input.executionMode
          ? { executionMode: input.executionMode }
          : {}),
        ...(input.lockdown === undefined ? {} : { lockdown: input.lockdown }),
        revision: sql`${systemSettings.revision} + 1`,
        updatedAt: input.updatedAt,
        updatedBy: input.updatedBy,
      })
      .where(
        and(
          eq(systemSettings.key, SETTINGS_KEY),
          eq(systemSettings.revision, expectedRevision),
        ),
      )
      .returning();
    return state;
  }
}

export class InMemoryExecutionStateStore implements ExecutionStateStore {
  private state: StoredExecutionState;

  constructor(initial: Partial<StoredExecutionState> = {}) {
    this.state = { ...DEFAULT_STATE, ...initial };
  }

  async get(): Promise<StoredExecutionState> {
    return { ...this.state };
  }

  async update(
    input: ExecutionStateUpdate,
    expectedRevision: number,
  ): Promise<StoredExecutionState | undefined> {
    if (this.state.revision !== expectedRevision) return undefined;
    this.state = {
      ...this.state,
      ...(input.executionMode
        ? { executionMode: input.executionMode }
        : {}),
      ...(input.lockdown === undefined ? {} : { lockdown: input.lockdown }),
      revision: this.state.revision + 1,
      updatedAt: input.updatedAt,
      updatedBy: input.updatedBy,
    };
    return { ...this.state };
  }
}

export class ExecutionModeCeilingError extends Error {
  override readonly name = "ExecutionModeCeilingError";

  constructor(readonly maximum: ExecutionMode) {
    super(
      `The requested execution mode exceeds the configured maximum of ${maximum}.`,
    );
  }
}

export class LockdownActiveError extends Error {
  override readonly name = "LockdownActiveError";

  constructor() {
    super("Lockdown must be disabled before increasing execution authority.");
  }
}

export class StaleExecutionStateError extends Error {
  override readonly name = "StaleExecutionStateError";

  constructor() {
    super(
      "Execution settings changed while this action was being authorized. Request the action again.",
    );
  }
}

export class ExecutionStateService {
  constructor(
    private readonly store: ExecutionStateStore,
    readonly maxExecutionMode: ExecutionMode,
  ) {}

  async getState(): Promise<ExecutionState> {
    return this.withEffectiveMode(await this.store.get());
  }

  async setExecutionMode(
    requested: ExecutionMode,
    updatedBy: string,
    now: Date,
    expectedRevision: number,
  ): Promise<ExecutionState> {
    this.assertWithinCeiling(requested);
    const current = await this.store.get();
    this.assertCurrentRevision(current, expectedRevision);
    if (current.lockdown && requested !== "SAFE") {
      throw new LockdownActiveError();
    }
    return this.updateAtRevision(
      { executionMode: requested, updatedAt: now, updatedBy },
      expectedRevision,
    );
  }

  async enableLockdown(
    updatedBy: string,
    now: Date,
    expectedRevision: number,
  ): Promise<ExecutionState> {
    return this.updateAtRevision(
      {
        executionMode: "SAFE",
        lockdown: true,
        updatedAt: now,
        updatedBy,
      },
      expectedRevision,
    );
  }

  async disableLockdown(
    requestedMode: ExecutionMode,
    updatedBy: string,
    now: Date,
    expectedRevision: number,
  ): Promise<ExecutionState> {
    this.assertWithinCeiling(requestedMode);
    const current = await this.store.get();
    this.assertCurrentRevision(current, expectedRevision);
    return this.updateAtRevision(
      {
        executionMode: requestedMode,
        lockdown: false,
        updatedAt: now,
        updatedBy,
      },
      expectedRevision,
    );
  }

  private async updateAtRevision(
    input: ExecutionStateUpdate,
    expectedRevision: number,
  ): Promise<ExecutionState> {
    const updated = await this.store.update(input, expectedRevision);
    if (!updated) throw new StaleExecutionStateError();
    return this.withEffectiveMode(updated);
  }

  private assertCurrentRevision(
    current: StoredExecutionState,
    expectedRevision: number,
  ): void {
    if (current.revision !== expectedRevision) {
      throw new StaleExecutionStateError();
    }
  }

  private assertWithinCeiling(requested: ExecutionMode): void {
    if (compareExecutionModes(requested, this.maxExecutionMode) > 0) {
      throw new ExecutionModeCeilingError(this.maxExecutionMode);
    }
  }

  private withEffectiveMode(stored: StoredExecutionState): ExecutionState {
    return {
      ...stored,
      maxExecutionMode: this.maxExecutionMode,
      effectiveExecutionMode: effectiveExecutionMode(
        stored.executionMode,
        this.maxExecutionMode,
        stored.lockdown,
      ),
    };
  }
}
