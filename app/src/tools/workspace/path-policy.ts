const CREDENTIAL_DIRECTORIES = new Set([
  ".aws",
  ".gnupg",
  ".ssh",
]);

/**
 * Shared content boundary for every model-visible workspace reader.
 * `.env.example` is documentation; every other `.env*` file is private.
 */
export function isBlockedWorkspacePath(relative: string): boolean {
  const segments = relative
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase("en-US"));
  return segments.some((segment, index) =>
    isBlockedWorkspaceSegment(segment, index === segments.length - 1),
  );
}

function isBlockedWorkspaceSegment(name: string, isFinal: boolean): boolean {
  if (CREDENTIAL_DIRECTORIES.has(name)) return true;
  if (isFinal && name === ".env.example") return false;
  if (name.startsWith(".env")) return true;
  return (
    /(?:^|[-_.])(?:credential|credentials|password|passwords|secret|secrets|token|tokens)(?:[-_.]|$)/i.test(
      name,
    ) ||
    /^(?:id_rsa|id_ed25519)(?:\.pub)?$/i.test(name) ||
    /^(?:\.netrc|\.npmrc|\.pypirc|application_default_credentials\.json)$/i.test(
      name,
    ) ||
    /^service[-_.]?account(?:[-_.].*)?\.json$/i.test(name) ||
    /\.(?:key|pem|p12|pfx)$/i.test(name)
  );
}

const RECURSIVE_SENSITIVE_GLOBS = [
  ".env",
  ".env.*",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "application_default_credentials.json",
  "service-account*.json",
  "service_account*.json",
  "*credential*",
  "*password*",
  "*secret*",
  "*token*",
  "id_rsa*",
  "id_ed25519*",
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
] as const;

/** Ripgrep exclusions used when a search starts at a safe parent directory. */
export const WORKSPACE_RG_EXCLUDES = [
  ...[...CREDENTIAL_DIRECTORIES].map((directory) => `!**/${directory}/**`),
  ...RECURSIVE_SENSITIVE_GLOBS.flatMap((glob) => [
    `!**/${glob}`,
    `!**/${glob}/**`,
  ]),
  "**/.env.example",
];

/** Git pathspec exclusions used by commands that can print file contents. */
export const WORKSPACE_GIT_EXCLUDES = [
  ...[...CREDENTIAL_DIRECTORIES].map(
    (directory) => `:(icase,exclude)**/${directory}/**`,
  ),
  ...RECURSIVE_SENSITIVE_GLOBS.filter((glob) => glob !== ".env.*").flatMap((glob) => [
    `:(icase,exclude)**/${glob}`,
    `:(icase,exclude)**/${glob}/**`,
  ]),
  ...[".env.local", ".env.development", ".env.production", ".env.test", ".env.staging"].map(
    (name) => `:(icase,exclude)**/${name}`,
  ),
];
