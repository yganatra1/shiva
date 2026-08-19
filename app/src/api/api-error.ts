export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}
