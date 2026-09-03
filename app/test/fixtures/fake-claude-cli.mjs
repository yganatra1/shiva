#!/usr/bin/env node
// Test-only stand-in for the `claude` CLI, spawned by ClaudeCodeRunner tests
// via the `command` test seam. Branches on the instruction text (the -p
// argument) to simulate the outcomes the runner must handle. Emits
// newline-delimited JSON matching --output-format stream-json's shape: a
// "result" event is the one ClaudeCodeRunner treats as terminal.

const instruction = process.argv[3] ?? "";

function writeLine(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

switch (instruction) {
  case "ECHO_ARGV":
    writeLine({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "checking argv" }],
      },
    });
    writeLine({
      type: "result",
      result: JSON.stringify(process.argv.slice(2)),
    });
    process.exit(0);
    break;
  case "SUCCESS":
    writeLine({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "figuring out what to do" },
          { type: "text", text: "Doing the thing now." },
          { type: "tool_use", name: "Bash", input: { command: "echo hi" } },
        ],
      },
    });
    writeLine({
      type: "result",
      session_id: "sess-1",
      result: "did the thing",
      is_error: false,
    });
    process.exit(0);
    break;
  case "SLOW_SUCCESS":
    setTimeout(() => {
      writeLine({
        type: "result",
        session_id: "sess-slow",
        result: "did the slow thing",
        is_error: false,
      });
      process.exit(0);
    }, 150);
    break;
  case "IS_ERROR":
    writeLine({
      type: "result",
      session_id: "sess-2",
      result: "could not finish",
      is_error: true,
    });
    process.exit(0);
    break;
  case "MALFORMED":
    process.stdout.write("not json");
    process.exit(0);
    break;
  case "MISSING_RESULT_FIELD":
    writeLine({ type: "result", session_id: "sess-3" });
    process.exit(0);
    break;
  case "FAIL":
    process.stderr.write("boom");
    process.exit(1);
    break;
  case "HANG":
    // Ignore SIGTERM so the runner is forced to escalate to SIGKILL.
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
    process.stderr.write(`unknown fixture instruction: ${instruction}`);
    process.exit(1);
}
