import assert from "node:assert/strict";
import { test } from "node:test";

import { formatIsoWithOffset } from "../src/types/time";

test("formatIsoWithOffset expresses the instant in the target zone's own offset, not UTC", () => {
  const instant = new Date("2026-08-26T13:27:23Z");

  assert.equal(
    formatIsoWithOffset(instant, "Asia/Kolkata"),
    "2026-08-26T18:57:23+05:30",
  );
  assert.equal(
    formatIsoWithOffset(instant, "America/New_York"),
    "2026-08-26T09:27:23-04:00",
  );
  assert.equal(formatIsoWithOffset(instant, "UTC"), "2026-08-26T13:27:23+00:00");
});

test("formatIsoWithOffset round-trips to the same instant (to the second)", () => {
  const instant = new Date("2026-08-26T13:27:23Z");
  const roundTripped = new Date(formatIsoWithOffset(instant, "Asia/Kolkata"));
  assert.equal(roundTripped.getTime(), instant.getTime());
});

test("formatIsoWithOffset handles a half-hour offset across a date boundary", () => {
  // 23:45 UTC + 5:30 rolls into the next day in Kolkata.
  const instant = new Date("2026-08-26T23:45:00Z");
  assert.equal(
    formatIsoWithOffset(instant, "Asia/Kolkata"),
    "2026-08-27T05:15:00+05:30",
  );
});
