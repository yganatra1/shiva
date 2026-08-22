const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;
const MAX_KEYS = 64;
const MAX_ARRAY_ITEMS = 64;
const MAX_STRING_LENGTH = 2_000;
const MAX_NODES = 2_048;

const SECRET_KEY_SUFFIXES = [
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "passphrase",
  "privatekey",
  "refreshtoken",
  "accesstoken",
  "clientsecret",
  "connectionstring",
  "databaseurl",
  "dsn",
  "secret",
  "secretaccesskey",
  "secretkey",
  "sessiontoken",
  "token",
  "apikey",
  "awssecretaccesskey",
] as const;
const LABELED_SECRET_PATTERN =
  /(["']?(?:password|passwd|passphrase|secret|secret[_-]?(?:access[_-]?)?key|token|oauth[_-]?token|refresh[_-]?token|access[_-]?token|session[_-]?token|client[_-]?secret|api[_-]?key|authorization|cookie|database[_-]?url|connection[_-]?string|dsn)["']?\s*(?::|=|\bis\b)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const URL_CREDENTIAL_PATTERN =
  /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const COMMON_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

export const REDACTED_SKILL_PAYLOAD = Object.freeze({ redacted: true });

const PRIVATE_AUDIT_SKILLS = new Set([
  "record_expense",
  "expense_report",
  "learn_about_shiva",
]);

export function sanitizeSkillAuditInput(skill: string, payload: unknown): unknown {
  if (PRIVATE_AUDIT_SKILLS.has(skill)) return REDACTED_SKILL_PAYLOAD;
  return sanitizeAuditPayload(payload);
}

export function sanitizeSkillAuditResult(skill: string, payload: unknown): unknown {
  if (PRIVATE_AUDIT_SKILLS.has(skill) || skill === "workspace_terminal") {
    return REDACTED_SKILL_PAYLOAD;
  }
  return sanitizeAuditPayload(payload);
}

export function sanitizeAuditPayload(payload: unknown): unknown {
  return sanitizePayload(payload, {
    maxDepth: MAX_DEPTH,
    maxKeys: MAX_KEYS,
    maxArrayItems: MAX_ARRAY_ITEMS,
    maxStringLength: MAX_STRING_LENGTH,
    maxNodes: MAX_NODES,
  });
}

interface SanitizationLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringLength: number;
  readonly maxNodes: number;
}

function sanitizePayload(payload: unknown, limits: SanitizationLimits): unknown {
  return sanitizeValue(payload, 0, {
    remainingNodes: limits.maxNodes,
    seen: new Set<object>(),
    limits,
  });
}

export function sanitizeAuditText(value: string, maxLength = MAX_STRING_LENGTH): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(LABELED_SECRET_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(AWS_ACCESS_KEY_PATTERN, REDACTED)
    .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]@")
    .replace(JWT_PATTERN, REDACTED)
    .replace(COMMON_TOKEN_PATTERN, REDACTED)
    .slice(0, maxLength);
}

interface SanitizationState {
  remainingNodes: number;
  readonly seen: Set<object>;
  readonly limits: SanitizationLimits;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  state: SanitizationState,
): unknown {
  if (state.remainingNodes <= 0) return "[TRUNCATED]";
  state.remainingNodes -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return sanitizeAuditText(value, state.limits.maxStringLength);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return { receivedType: typeof value };
  if (depth >= state.limits.maxDepth) return "[TRUNCATED]";
  if (state.seen.has(value)) return "[CIRCULAR]";

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, state.limits.maxArrayItems)
        .map((entry) => sanitizeValue(entry, depth + 1, state));
    }

    return Object.fromEntries(
      Object.entries(value)
        .slice(0, state.limits.maxKeys)
        .map(([key, entry]) => [
          sanitizeAuditText(key, 100),
          isSecretKey(key)
            ? REDACTED
            : sanitizeValue(entry, depth + 1, state),
        ]),
    );
  } finally {
    state.seen.delete(value);
  }
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SECRET_KEY_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(suffix),
  );
}
