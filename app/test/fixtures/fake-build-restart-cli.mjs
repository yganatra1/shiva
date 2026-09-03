#!/usr/bin/env node
// Test-only stand-in for both `npm` and `pm2`, spawned by BuildRestartRunner
// tests via the npmCommand/pm2Command test seams. Branches on the invoked
// step ("run build", "restart <name>", or "jlist") and an env var selecting
// the mode for that step, to simulate the outcomes the runner must handle.

const args = process.argv.slice(2);
const isBuildStep = args[0] === "run" && args[1] === "build";
const isRestartStep = args[0] === "restart";
const isListStep = args[0] === "jlist";
const mode = isBuildStep
  ? process.env.BUILD_MODE
  : isRestartStep
    ? process.env.RESTART_MODE
    : isListStep
      ? process.env.LIST_MODE
      : undefined;

switch (mode) {
  case "SUCCESS":
    process.stdout.write(`ok: ${args.join(" ")}`);
    process.exit(0);
    break;
  case "JSON":
    process.stdout.write(process.env.LIST_JSON ?? "[]");
    process.exit(0);
    break;
  case "INVALID_JSON":
    process.stdout.write("not valid json");
    process.exit(0);
    break;
  case "FAIL":
    process.stderr.write("boom");
    process.exit(1);
    break;
  case "HANG":
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
    break;
  case "BIG_OUTPUT":
    process.on("SIGTERM", () => {});
    setInterval(() => {
      process.stdout.write("x".repeat(1_024));
    }, 1);
    break;
  default:
    process.stderr.write(`unknown fixture mode for ${args.join(" ")}: ${mode}`);
    process.exit(1);
}
