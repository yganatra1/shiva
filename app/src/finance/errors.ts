export type MutualFundFailureCode =
  | "MFAPI_TIMEOUT"
  | "MFAPI_UNAVAILABLE"
  | "MFAPI_INVALID_RESPONSE"
  | "MFAPI_NOT_FOUND"
  | "MFAPI_RATE_LIMITED"
  | "SCHEME_NOT_FOUND"
  | "INSUFFICIENT_NAV_HISTORY"
  | "INVALID_SCHEME_CODE"
  | "COMPARISON_LIMIT"
  | "RANKING_LIMIT"
  | "CATEGORY_MISMATCH"
  | "NO_ELIGIBLE_FUNDS";

export class MutualFundError extends Error {
  override readonly name = "MutualFundError";

  constructor(
    readonly code: MutualFundFailureCode,
    message: string,
    options?: ErrorOptions & { readonly status?: number },
  ) {
    super(message, options);
    if (options?.status !== undefined) this.status = options.status;
  }

  readonly status?: number;
}

export function mutualFundErrorToFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof MutualFundError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "MUTUAL_FUND_FAILED",
    message: "Mutual-fund research could not be completed.",
  };
}
