import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ReadOnlyWorkspaceTerminal,
  WorkspaceTerminalError,
} from "../src/tools/workspace/terminal.js";
import {
  isBlockedWorkspacePath,
  WORKSPACE_GIT_EXCLUDES,
  WORKSPACE_RG_EXCLUDES,
} from "../src/tools/workspace/path-policy.js";

test("shared workspace policy blocks sensitive names at any path depth", () => {
  for (const privatePath of [
    ".env",
    "config/.env.production",
    ".npmrc",
    "secrets/config.json",
    "nested/CREDENTIALS/aws.json",
    ".gnupg/private.txt",
    "config/service-account.json",
    "keys/private.pem",
  ]) {
    assert.equal(isBlockedWorkspacePath(privatePath), true, privatePath);
  }
  assert.equal(isBlockedWorkspacePath(".env.example"), false);
  assert.equal(isBlockedWorkspacePath("src/public-config.ts"), false);

  const recursivePolicy = [
    ...WORKSPACE_RG_EXCLUDES,
    ...WORKSPACE_GIT_EXCLUDES,
  ].join("\n");
  for (const expected of [
    ".gnupg",
    ".npmrc",
    "service-account",
    "*credential*",
    "*.pem",
  ]) {
    assert.match(recursivePolicy, new RegExp(expected.replaceAll("*", "\\*")));
  }
});

test("workspace terminal denies credential paths and omits them from recursive search", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "shiva-workspace-terminal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, "secrets"), { recursive: true }),
    mkdir(path.join(root, "credentials"), { recursive: true }),
    mkdir(path.join(root, ".gnupg"), { recursive: true }),
    mkdir(path.join(root, "config"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "safe.txt"), "public fixture\n"),
    writeFile(path.join(root, ".env.example"), "TOKEN=<placeholder>\n"),
    writeFile(path.join(root, ".env"), "TOKEN=ENV_SECRET_SENTINEL\n"),
    writeFile(path.join(root, ".npmrc"), "//registry/:_authToken=NPM_SECRET_SENTINEL\n"),
    writeFile(path.join(root, "secrets", "config.json"), "SECRETS_DIR_SENTINEL\n"),
    writeFile(path.join(root, "credentials", "aws.json"), "CREDENTIALS_DIR_SENTINEL\n"),
    writeFile(path.join(root, ".gnupg", "private.txt"), "GNUPG_SECRET_SENTINEL\n"),
    writeFile(path.join(root, "config", "service-account.json"), "SERVICE_ACCOUNT_SENTINEL\n"),
    writeFile(path.join(root, "private.pem"), "PRIVATE_KEY_SENTINEL\n"),
  ]);
  const terminal = new ReadOnlyWorkspaceTerminal({ root });

  const example = await terminal.execute({ command: "cat", args: [".env.example"] });
  assert.match(example.stdout, /placeholder/);

  for (const deniedPath of [
    ".env",
    ".npmrc",
    "secrets/config.json",
    "credentials/aws.json",
    ".gnupg/private.txt",
    "config/service-account.json",
    "private.pem",
  ]) {
    await assert.rejects(
      terminal.execute({ command: "cat", args: [deniedPath] }),
      (error: unknown) =>
        error instanceof WorkspaceTerminalError && error.failure === "PATH_DENIED",
      deniedPath,
    );
  }

  let files;
  try {
    files = await terminal.execute({ command: "rg", args: ["--files"] });
  } catch (error: unknown) {
    if (
      error instanceof WorkspaceTerminalError &&
      error.failure === "UNAVAILABLE"
    ) {
      context.diagnostic("rg is not installed in the terminal's production-safe PATH");
      return;
    }
    throw error;
  }
  assert.equal(files.exitCode, 0);
  assert.match(files.stdout, /safe\.txt/);
  for (const privatePath of [
    ".env",
    ".npmrc",
    "secrets/config.json",
    "credentials/aws.json",
    ".gnupg/private.txt",
    "config/service-account.json",
    "private.pem",
  ]) {
    assert.equal(files.stdout.includes(privatePath), false, privatePath);
  }
});
