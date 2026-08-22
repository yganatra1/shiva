import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableColumns } from "drizzle-orm";

import type { ShivaDatabase } from "../src/database/pool.js";
import { systemSettings } from "../src/database/schema.js";
import {
  compareExecutionModes,
  effectiveExecutionMode,
  minExecutionMode,
} from "../src/security/execution-mode.js";
import {
  ExecutionModeCeilingError,
  ExecutionStateService,
  DrizzleExecutionStateStore,
  InMemoryExecutionStateStore,
  StaleExecutionStateError,
} from "../src/security/execution-state.js";
import type { StoredExecutionState } from "../src/security/execution-mode.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-22T10:00:00.000Z");

test("execution mode ordering and configured ceiling use explicit ranks", () => {
  assert.ok(compareExecutionModes("SAFE", "AUTO") < 0);
  assert.ok(compareExecutionModes("AUTO", "FULL_ACCESS") < 0);
  assert.equal(minExecutionMode("FULL_ACCESS", "AUTO"), "AUTO");
  assert.equal(effectiveExecutionMode("FULL_ACCESS", "AUTO", false), "AUTO");
  assert.equal(
    effectiveExecutionMode("FULL_ACCESS", "FULL_ACCESS", true),
    "SAFE",
  );
});

test("system settings schema stores the durable typed global state", () => {
  assert.deepEqual(Object.keys(getTableColumns(systemSettings)), [
    "key",
    "executionMode",
    "lockdown",
    "revision",
    "updatedAt",
    "updatedBy",
  ]);
});

test("a second service instance observes the execution mode persisted by its store", async () => {
  const store = new InMemoryExecutionStateStore({
    executionMode: "AUTO",
    updatedAt: NOW,
  });
  const firstRuntime = new ExecutionStateService(store, "FULL_ACCESS");
  await firstRuntime.setExecutionMode("FULL_ACCESS", USER_ID, NOW, 0);

  const restartedRuntime = new ExecutionStateService(store, "FULL_ACCESS");
  const restartedState = await restartedRuntime.getState();
  assert.equal(restartedState.executionMode, "FULL_ACCESS");
  assert.equal(restartedState.effectiveExecutionMode, "FULL_ACCESS");
  assert.equal(restartedState.revision, 1);
});

test("a fresh Drizzle repository instance reads the mode persisted in database state", async () => {
  const persisted: { state: StoredExecutionState } = {
    state: {
      executionMode: "AUTO",
      lockdown: false,
      revision: 0,
      updatedAt: NOW,
      updatedBy: null,
    },
  };
  const database = fakeSettingsDatabase(persisted);
  await new DrizzleExecutionStateStore(database).update(
    {
      executionMode: "FULL_ACCESS",
      updatedAt: NOW,
      updatedBy: USER_ID,
    },
    0,
  );

  const afterRestart = await new DrizzleExecutionStateStore(database).get();
  assert.equal(afterRestart.executionMode, "FULL_ACCESS");
  assert.equal(afterRestart.updatedBy, USER_ID);
  assert.equal(afterRestart.revision, 1);
});

test("the host ceiling rejects persistence above max and clamps corrupted stored state", async () => {
  const store = new InMemoryExecutionStateStore({
    executionMode: "FULL_ACCESS",
    updatedAt: NOW,
  });
  const state = new ExecutionStateService(store, "AUTO");

  assert.equal((await state.getState()).executionMode, "FULL_ACCESS");
  assert.equal((await state.getState()).effectiveExecutionMode, "AUTO");
  await assert.rejects(
    state.setExecutionMode("FULL_ACCESS", USER_ID, NOW, 0),
    ExecutionModeCeilingError,
  );
});

test("lockdown persists Safe mode and requires an explicit post-lockdown target", async () => {
  const store = new InMemoryExecutionStateStore({
    executionMode: "FULL_ACCESS",
    updatedAt: NOW,
  });
  const state = new ExecutionStateService(store, "FULL_ACCESS");

  const locked = await state.enableLockdown(USER_ID, NOW, 0);
  assert.equal(locked.executionMode, "SAFE");
  assert.equal(locked.effectiveExecutionMode, "SAFE");
  assert.equal(locked.lockdown, true);

  const unlocked = await state.disableLockdown("AUTO", USER_ID, NOW, 1);
  assert.equal(unlocked.executionMode, "AUTO");
  assert.equal(unlocked.effectiveExecutionMode, "AUTO");
  assert.equal(unlocked.lockdown, false);
  assert.equal(unlocked.revision, 2);
});

test("compare-and-set rejects a stale state transition without overwriting the winner", async () => {
  const store = new InMemoryExecutionStateStore({
    executionMode: "FULL_ACCESS",
    updatedAt: NOW,
  });
  const state = new ExecutionStateService(store, "FULL_ACCESS");

  const winner = await state.setExecutionMode("SAFE", USER_ID, NOW, 0);
  assert.equal(winner.executionMode, "SAFE");
  assert.equal(winner.revision, 1);

  await assert.rejects(
    state.setExecutionMode("AUTO", USER_ID, NOW, 0),
    StaleExecutionStateError,
  );
  assert.deepEqual(await state.getState(), winner);
});

function fakeSettingsDatabase(persisted: {
  state: StoredExecutionState;
}): ShivaDatabase {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => undefined,
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ key: "global", ...persisted.state }],
        }),
      }),
    }),
    update: () => ({
      set: (values: Partial<StoredExecutionState>) => ({
        where: () => ({
          returning: async () => {
            const { revision: _revisionExpression, ...updates } = values;
            persisted.state = {
              ...persisted.state,
              ...updates,
              revision: persisted.state.revision + 1,
            };
            return [{ key: "global", ...persisted.state }];
          },
        }),
      }),
    }),
  } as unknown as ShivaDatabase;
}
