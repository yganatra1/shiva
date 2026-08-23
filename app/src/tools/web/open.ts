import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from "undici";

import type {
  OpenedWebPage,
  WebOpenInput,
  WebOpenToolPort,
} from "./types";
import { WebToolError } from "./types";

interface AddressRecord {
  readonly address: string;
  readonly family: number;
}

interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

interface ValidatedWebTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly addresses: readonly PinnedAddress[];
}

interface WebOpenToolOptions {
  readonly requestTimeoutMs: number;
  readonly maxContentBytes: number;
  readonly maxRedirects?: number;
  readonly fetchFunction?: typeof fetch;
  readonly lookup?: (hostname: string) => Promise<readonly AddressRecord[]>;
}

const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/xhtml+xml",
];

export class WebOpenTool implements WebOpenToolPort {
  private readonly fetchFunction: typeof fetch | undefined;
  private readonly lookup: (hostname: string) => Promise<readonly AddressRecord[]>;

  constructor(private readonly options: WebOpenToolOptions) {
    this.fetchFunction = options.fetchFunction;
    this.lookup = options.lookup ?? defaultLookup;
  }

  async open(input: WebOpenInput): Promise<OpenedWebPage> {
    const deadline = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline.signal])
      : deadline.signal;
    const timeout = setTimeout(
      () => deadline.abort(),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      let target = await this.validateUrl(input.url);
      const maxRedirects = this.options.maxRedirects ?? 3;
      for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        const dispatcher = this.fetchFunction
          ? undefined
          : createPinnedDispatcher(target);
        try {
          const requestInit = {
            method: "GET",
            headers: {
              accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
              "user-agent": "Shiva/0.3 web-research",
            },
            redirect: "manual",
            signal,
          } satisfies RequestInit;
          const response = this.fetchFunction
            ? await this.fetchFunction(target.url, requestInit)
            : await secureFetch(target.url, requestInit, dispatcher!);

          if (isRedirect(response.status)) {
            await discardBody(response);
            const location = response.headers.get("location");
            if (!location || redirect === maxRedirects) {
              throw new WebToolError(
                "INVALID_RESPONSE",
                "The web page exceeded the redirect limit.",
              );
            }
            target = await this.validateUrl(
              new URL(location, target.url).toString(),
            );
            continue;
          }
          if (!response.ok) {
            await discardBody(response);
            throw new WebToolError(
              "UNAVAILABLE",
              `The web page returned HTTP status ${response.status}.`,
            );
          }

          const contentType = (response.headers.get("content-type") ?? "")
            .split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (!contentType || !ALLOWED_CONTENT_TYPES.includes(contentType)) {
            await discardBody(response);
            throw new WebToolError(
              "INVALID_RESPONSE",
              "The URL did not return a supported text document.",
            );
          }

          const body = await readLimitedBody(
            response,
            this.options.maxContentBytes,
          );
          const html = new TextDecoder().decode(body);
          return {
            url: target.url.toString(),
            title:
              contentType === "text/html" ||
              contentType === "application/xhtml+xml"
                ? extractTitle(html)
                : null,
            content:
              contentType === "text/plain"
                ? normalizeText(html)
                : htmlToText(html),
          };
        } finally {
          if (dispatcher) {
            await closeDispatcher(dispatcher);
          }
        }
      }
      throw new WebToolError(
        "INVALID_RESPONSE",
        "The web page could not be opened.",
      );
    } catch (error: unknown) {
      if (error instanceof WebToolError) throw error;
      if (deadline.signal.aborted) {
        throw new WebToolError(
          "TIMEOUT",
          "The web page did not respond before its deadline.",
          { cause: error },
        );
      }
      if (input.signal?.aborted) throw error;
      throw new WebToolError(
        "UNAVAILABLE",
        "The web page could not be opened.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async validateUrl(rawUrl: string): Promise<ValidatedWebTarget> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error: unknown) {
      throw new WebToolError("BLOCKED_URL", "The URL is invalid.", {
        cause: error,
      });
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      throw new WebToolError(
        "BLOCKED_URL",
        "Only public HTTP and HTTPS URLs can be opened.",
      );
    }
    const hostname = normalizeHostname(url.hostname);
    if (isBlockedHostname(hostname)) {
      throw new WebToolError("BLOCKED_URL", "Private URLs are not allowed.");
    }

    const literalFamily = isIP(hostname);
    const resolved = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await this.lookup(hostname);
    const addresses = validateAddresses(resolved);
    if (addresses.length === 0) {
      throw new WebToolError("BLOCKED_URL", "Private URLs are not allowed.");
    }
    return { url, hostname, addresses };
  }
}

function createPinnedDispatcher(target: ValidatedWebTarget): Agent {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(target.hostname, target.addresses),
    },
  });
}

/**
 * Produces the connect-time resolver used by Undici after URL validation.
 * It never performs DNS and can return only the exact public addresses that
 * were already checked for this target, closing the validation/fetch gap.
 */
export function createPinnedLookup(
  expectedHostname: string,
  addresses: readonly PinnedAddress[],
): NonNullable<import("node:net").TcpNetConnectOpts["lookup"]> {
  const normalizedExpectedHostname = normalizeHostname(expectedHostname);
  const pinned = addresses.map((record) => ({ ...record }));

  return (hostname, options, callback): void => {
    const requestedFamily = options.family ?? 0;
    const eligible = pinned.filter(
      (record) => requestedFamily === 0 || record.family === requestedFamily,
    );
    if (
      normalizeHostname(hostname) !== normalizedExpectedHostname ||
      eligible.length === 0
    ) {
      callback(pinnedLookupError(hostname), "", 0);
      return;
    }

    if (options.all) {
      callback(
        null,
        eligible.map((record) => ({ ...record })),
      );
      return;
    }
    const selected = eligible[0]!;
    callback(null, selected.address, selected.family);
  };
}

function validateAddresses(
  records: readonly AddressRecord[],
): readonly PinnedAddress[] {
  const validated: PinnedAddress[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const family = isIP(record.address);
    if (
      (family !== 4 && family !== 6) ||
      record.family !== family ||
      isBlockedAddress(record.address)
    ) {
      return [];
    }
    const key = `${family}:${record.address.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      validated.push({ address: record.address, family });
    }
  }
  return validated;
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

function pinnedLookupError(hostname: string): NodeJS.ErrnoException {
  return Object.assign(new Error("The validated web target could not be resolved."), {
    code: "ENOTFOUND",
    hostname,
  });
}

async function secureFetch(
  url: URL,
  init: RequestInit,
  dispatcher: Dispatcher,
): Promise<Response> {
  return (await undiciFetch(url, {
    ...(init as unknown as UndiciRequestInit),
    dispatcher,
  })) as unknown as Response;
}

async function closeDispatcher(dispatcher: Dispatcher): Promise<void> {
  try {
    await dispatcher.close();
  } catch {
    try {
      await dispatcher.destroy();
    } catch {
      // Cleanup diagnostics must not replace the request's sanitized outcome.
    }
  }
}

async function defaultLookup(hostname: string): Promise<readonly AddressRecord[]> {
  return nodeLookup(hostname, { all: true, verbatim: true });
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

function isBlockedAddress(address: string): boolean {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    return (
      // Block the low IPv6 space, including loopback, IPv4-compatible,
      // IPv4-mapped, and IPv4-translated spellings. Otherwise a literal such
      // as ::ffff:7f00:1 can encode 127.0.0.1 without containing dotted IPv4.
      normalized.startsWith("::") ||
      normalized.startsWith("0:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("64:ff9b:") ||
      normalized.startsWith("2002:") ||
      normalized.startsWith("2001:db8:")
    );
  }

  const parts = address.split(".").map(Number);
  const first = parts[0];
  const second = parts[1];
  if (parts.length !== 4 || first === undefined || second === undefined) {
    return true;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 2) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await discardBody(response);
    throw new WebToolError(
      "INVALID_RESPONSE",
      "The web page is too large to inspect safely.",
    );
  }
  if (!response.body) {
    throw new WebToolError(
      "INVALID_RESPONSE",
      "The web page returned no content.",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new WebToolError(
          "INVALID_RESPONSE",
          "The web page is too large to inspect safely.",
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original parse or size failure.
    }
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function extractTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(normalizeText(match[1])) : null;
}

function htmlToText(html: string): string {
  return decodeEntities(
    normalizeText(
      html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number(decimal)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The sanitized upstream status is already the actionable failure.
  }
}
