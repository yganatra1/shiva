export const FACE_EMBEDDING_DIMENSIONS = 512;

export type FaceAnalysisMode = "enroll" | "identify" | "verify";

export type FaceProviderFailure =
  | "CANCELLED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_IMAGE"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "NO_FACE"
  | "MULTIPLE_FACES"
  | "INVALID_RESPONSE";

export class FaceProviderError extends Error {
  override readonly name = "FaceProviderError";

  constructor(
    readonly failure: FaceProviderFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface FaceBoundingBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface FaceObservation {
  /** L2-normalized buffalo_l recognition vector. Never expose this over Shiva's public API. */
  readonly embedding: readonly number[];
  readonly boundingBox: FaceBoundingBox;
  readonly detectionScore: number;
  readonly qualityScore: number;
  readonly enrollmentEligible: boolean;
  readonly rejectionReasons: readonly string[];
}

export interface FaceAnalysisResult {
  readonly model: string;
  readonly dimensions: typeof FACE_EMBEDDING_DIMENSIONS;
  readonly provider: string;
  readonly image: {
    readonly width: number;
    readonly height: number;
  };
  readonly faces: readonly FaceObservation[];
}

export interface FaceAnalysisInput {
  readonly image: Uint8Array;
  readonly contentType: string;
  readonly mode: FaceAnalysisMode;
  readonly signal?: AbortSignal;
}

export interface FaceProvider {
  analyze(input: FaceAnalysisInput): Promise<FaceAnalysisResult>;
  health(signal?: AbortSignal): Promise<FaceProviderHealth>;
}

export interface FaceProviderHealth {
  readonly status: "ok";
  readonly service: "face";
  readonly model: string;
  readonly loaded: boolean;
  readonly provider: string | null;
}
