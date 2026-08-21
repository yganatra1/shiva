import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  WorkspaceAnalysis,
  WorkspaceAnalysisInput,
  WorkspaceDocument,
  WorkspaceMatch,
  WorkspaceOverview,
  WorkspaceReaderPort,
} from "./types.js";

const DEFAULT_WORKSPACE_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const MAX_DISCOVERED_FILES = 1_500;
const MAX_TREE_FILES = 180;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DOCUMENT_CHARACTERS = 12_000;
const MAX_MATCHES = 30;
const MAX_MATCH_CHARACTERS = 8_000;
const MAX_DEPTH = 12;
const CORE_DOCUMENTS = [
  "README.md",
  ".env.example",
  "app/package.json",
  "docs/agent-architecture.md",
  "docs/memory-architecture.md",
  "docs/voice-architecture.md",
] as const;
const BLOCKED_DIRECTORIES = new Set([
  ".agents",
  ".cache",
  ".codex",
  ".git",
  ".idea",
  ".venv",
  ".vscode",
  "backups",
  "coverage",
  "data",
  "dist",
  "logs",
  "models",
  "node_modules",
  "runtime",
]);
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".example",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);
const SAFE_EXTENSIONLESS_FILES = new Set([
  "Dockerfile",
  "LICENSE",
  "Makefile",
  "README",
]);
const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "can",
  "check",
  "current",
  "does",
  "for",
  "from",
  "have",
  "how",
  "into",
  "its",
  "make",
  "please",
  "shiva",
  "that",
  "the",
  "this",
  "what",
  "where",
  "with",
]);

export type WorkspaceReaderFailure =
  | "PATH_DENIED"
  | "NOT_FOUND"
  | "UNREADABLE";

export class WorkspaceReaderError extends Error {
  override readonly name = "WorkspaceReaderError";

  constructor(
    readonly failure: WorkspaceReaderFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface WorkspaceReaderOptions {
  readonly root?: string;
}

export class FileSystemWorkspaceReader implements WorkspaceReaderPort {
  private readonly root: string;
  private readonly rootRealPath: Promise<string>;

  constructor(options: WorkspaceReaderOptions = {}) {
    this.root = path.resolve(options.root ?? DEFAULT_WORKSPACE_ROOT);
    this.rootRealPath = realpath(this.root);
  }

  async overview(
    focus?: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceOverview> {
    const files = await this.discoverFiles(signal);
    const documents = await this.readDocuments(
      CORE_DOCUMENTS.filter((candidate) => files.includes(candidate)),
      signal,
    );
    const terms = focus ? deriveSearchTerms(focus) : [];
    const matches =
      terms.length > 0 ? await this.search(files, terms, signal) : [];
    return {
      workspace: "shiva",
      files: files.slice(0, MAX_TREE_FILES),
      documents,
      matches,
      truncated:
        files.length >= MAX_DISCOVERED_FILES ||
        files.length > MAX_TREE_FILES ||
        documents.some((document) => document.truncated),
    };
  }

  async analyze(input: WorkspaceAnalysisInput): Promise<WorkspaceAnalysis> {
    const files = await this.discoverFiles(input.signal);
    const requestedPaths = [...new Set(input.paths ?? [])].slice(0, 8);
    const documents = await this.readDocuments(requestedPaths, input.signal);
    const searchTerms = normalizeSearchTerms(
      input.searchTerms?.length
        ? input.searchTerms
        : deriveSearchTerms(input.question),
    );
    const matches = await this.search(files, searchTerms, input.signal);
    return {
      workspace: "shiva",
      question: input.question,
      files: files.slice(0, MAX_TREE_FILES),
      documents,
      matches,
      truncated:
        files.length >= MAX_DISCOVERED_FILES ||
        files.length > MAX_TREE_FILES ||
        documents.some((document) => document.truncated) ||
        matches.length >= MAX_MATCHES,
    };
  }

  private async discoverFiles(signal?: AbortSignal): Promise<string[]> {
    const files: string[] = [];
    const walk = async (directory: string, relative: string, depth: number) => {
      signal?.throwIfAborted();
      if (depth > MAX_DEPTH || files.length >= MAX_DISCOVERED_FILES) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (files.length >= MAX_DISCOVERED_FILES) return;
        const nextRelative = relative
          ? `${relative}/${entry.name}`
          : entry.name;
        if (isBlockedPath(nextRelative) || entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, nextRelative, depth + 1);
        } else if (entry.isFile() && isTextPath(nextRelative)) {
          files.push(nextRelative);
        }
      }
    };
    try {
      await walk(this.root, "", 0);
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      throw new WorkspaceReaderError(
        "UNREADABLE",
        "The Shiva workspace could not be inspected.",
        { cause: error },
      );
    }
    return files;
  }

  private async readDocuments(
    requestedPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument[]> {
    const documents: WorkspaceDocument[] = [];
    let remaining = MAX_DOCUMENT_CHARACTERS;
    for (let index = 0; index < requestedPaths.length; index += 1) {
      if (remaining <= 0) break;
      const filesRemaining = requestedPaths.length - index;
      const fairShare = Math.max(1_500, Math.floor(remaining / filesRemaining));
      const document = await this.readDocument(
        requestedPaths[index] ?? "",
        Math.min(6_000, fairShare, remaining),
        signal,
      );
      documents.push(document);
      remaining -= document.content.length;
    }
    return documents;
  }

  private async readDocument(
    requestedPath: string,
    characterLimit: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument> {
    const relative = validateRelativePath(requestedPath);
    const absolute = path.join(this.root, relative);
    try {
      signal?.throwIfAborted();
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new WorkspaceReaderError(
          "PATH_DENIED",
          "Only regular workspace files may be read.",
        );
      }
      if (metadata.size > MAX_FILE_BYTES) {
        throw new WorkspaceReaderError(
          "PATH_DENIED",
          "The requested workspace file exceeds the safe read limit.",
        );
      }
      const [rootRealPath, fileRealPath] = await Promise.all([
        this.rootRealPath,
        realpath(absolute),
      ]);
      if (
        fileRealPath !== rootRealPath &&
        !fileRealPath.startsWith(`${rootRealPath}${path.sep}`)
      ) {
        throw new WorkspaceReaderError(
          "PATH_DENIED",
          "The requested file is outside the Shiva workspace.",
        );
      }
      const content = await readFile(fileRealPath, {
        encoding: "utf8",
        ...(signal ? { signal } : {}),
      });
      if (content.includes("\0")) {
        throw new WorkspaceReaderError(
          "PATH_DENIED",
          "Binary workspace files cannot be read.",
        );
      }
      return {
        path: relative,
        content: content.slice(0, characterLimit),
        truncated: content.length > characterLimit,
      };
    } catch (error: unknown) {
      if (signal?.aborted || error instanceof WorkspaceReaderError) throw error;
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      throw new WorkspaceReaderError(
        code === "ENOENT" ? "NOT_FOUND" : "UNREADABLE",
        code === "ENOENT"
          ? "The requested workspace file does not exist."
          : "The requested workspace file could not be read.",
        { cause: error },
      );
    }
  }

  private async search(
    files: readonly string[],
    terms: readonly string[],
    signal?: AbortSignal,
  ): Promise<WorkspaceMatch[]> {
    if (terms.length === 0) return [];
    const matches: WorkspaceMatch[] = [];
    let usedCharacters = 0;
    for (const relative of files) {
      if (
        matches.length >= MAX_MATCHES ||
        usedCharacters >= MAX_MATCH_CHARACTERS
      ) {
        break;
      }
      signal?.throwIfAborted();
      let document: WorkspaceDocument;
      try {
        document = await this.readDocument(relative, MAX_FILE_BYTES, signal);
      } catch (error: unknown) {
        if (signal?.aborted) throw error;
        continue;
      }
      const lines = document.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const normalized = line.toLocaleLowerCase("en-US");
        if (!terms.some((term) => normalized.includes(term))) continue;
        const excerpt = line.trim().slice(0, 240);
        if (excerpt.length === 0) continue;
        if (usedCharacters + excerpt.length > MAX_MATCH_CHARACTERS) return matches;
        matches.push({ path: relative, line: index + 1, excerpt });
        usedCharacters += excerpt.length;
        if (matches.length >= MAX_MATCHES) return matches;
      }
    }
    return matches;
  }
}

function validateRelativePath(input: string): string {
  const trimmed = input.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\0") ||
    trimmed.includes("\\") ||
    path.isAbsolute(trimmed)
  ) {
    throw new WorkspaceReaderError(
      "PATH_DENIED",
      "Workspace paths must be safe relative paths.",
    );
  }
  const normalized = path.posix.normalize(trimmed.replace(/^\.\//, ""));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    isBlockedPath(normalized) ||
    !isTextPath(normalized)
  ) {
    throw new WorkspaceReaderError(
      "PATH_DENIED",
      "The requested workspace path is not readable by this skill.",
    );
  }
  return normalized;
}

function isBlockedPath(relative: string): boolean {
  const segments = relative.split("/");
  if (segments.some((segment) => BLOCKED_DIRECTORIES.has(segment))) return true;
  const name = segments.at(-1)?.toLocaleLowerCase("en-US") ?? "";
  if (name === ".env.example") return false;
  if (name.startsWith(".env")) return true;
  return (
    /(?:^|[-_.])(?:credential|credentials|secret|secrets|token|tokens)(?:[-_.]|$)/i.test(
      name,
    ) ||
    /^(?:id_rsa|id_ed25519)(?:\.pub)?$/i.test(name) ||
    /\.(?:key|pem|p12|pfx|crt|cer)$/i.test(name)
  );
}

function isTextPath(relative: string): boolean {
  const name = path.posix.basename(relative);
  const extension = path.posix.extname(name).toLocaleLowerCase("en-US");
  return TEXT_EXTENSIONS.has(extension) || SAFE_EXTENSIONLESS_FILES.has(name);
}

function deriveSearchTerms(question: string): string[] {
  return normalizeSearchTerms(
    question
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9_.-]+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

function normalizeSearchTerms(terms: readonly string[]): string[] {
  return [
    ...new Set(
      terms
        .map((term) => term.trim().toLocaleLowerCase("en-US"))
        .filter((term) => term.length >= 2 && term.length <= 80),
    ),
  ].slice(0, 8);
}
