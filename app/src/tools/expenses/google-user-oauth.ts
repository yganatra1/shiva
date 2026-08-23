import { OAuth2Client } from "google-auth-library";

import {
  GoogleSheetsExpenseError,
  type GoogleAccessTokenProvider,
} from "./google-sheets";

export interface GoogleUserOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export interface GoogleUserOAuthTokenClient {
  setCredentials(credentials: { readonly refresh_token: string }): void;
  getAccessToken(): Promise<{ readonly token?: string | null }>;
}

export type GoogleUserOAuthClientFactory = (
  options: Readonly<Pick<GoogleUserOAuthCredentials, "clientId" | "clientSecret">>,
) => GoogleUserOAuthTokenClient;

export interface GoogleUserOAuthAccessTokenProviderOptions
  extends GoogleUserOAuthCredentials {
  /** Test seam; production uses google-auth-library's OAuth2Client. */
  readonly createClient?: GoogleUserOAuthClientFactory;
}

/**
 * Exchanges a previously consented Google user's refresh token for short-lived
 * access tokens. Long-lived secrets remain caller-owned and are never logged or
 * included in surfaced errors.
 */
export class GoogleUserOAuthAccessTokenProvider
  implements GoogleAccessTokenProvider
{
  private readonly client: GoogleUserOAuthTokenClient;

  constructor(options: GoogleUserOAuthAccessTokenProviderOptions) {
    assertCredentials(options);

    try {
      const createClient = options.createClient ?? createOAuth2Client;
      this.client = createClient({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
      });
      this.client.setCredentials({ refresh_token: options.refreshToken });
    } catch {
      throw authFailure("Google OAuth credentials could not be initialized.");
    }
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();

    let response: { readonly token?: string | null };
    try {
      response = await waitForAbortable(this.client.getAccessToken(), signal);
      signal?.throwIfAborted();
    } catch (error: unknown) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      // Do not attach the provider error as a cause: OAuth failures can contain
      // request metadata that must not reach application logs.
      throw authFailure("Google OAuth authentication failed.");
    }

    const token = response.token;
    if (typeof token !== "string" || token.trim().length === 0) {
      throw authFailure("Google OAuth did not return an access token.");
    }
    return token;
  }
}

function createOAuth2Client(
  options: Readonly<Pick<GoogleUserOAuthCredentials, "clientId" | "clientSecret">>,
): GoogleUserOAuthTokenClient {
  return new OAuth2Client({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  });
}

function assertCredentials(credentials: GoogleUserOAuthCredentials): void {
  if (
    !isNonBlank(credentials.clientId) ||
    !isNonBlank(credentials.clientSecret) ||
    !isNonBlank(credentials.refreshToken)
  ) {
    throw authFailure("Google OAuth credentials are incomplete.");
  }
}

function isNonBlank(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function authFailure(message: string): GoogleSheetsExpenseError {
  return new GoogleSheetsExpenseError("AUTH", message);
}

async function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
