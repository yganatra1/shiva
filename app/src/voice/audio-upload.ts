export const SUPPORTED_CAPTURE_MIME_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "video/webm",
  "application/octet-stream",
]);

export const DEFAULT_CAPTURE_MIME_TYPE = "audio/webm";

/** Strips codec parameters so `audio/webm;codecs=opus` stays supported. */
export function normalizeCaptureMimeType(value: string | undefined): string {
  const base = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SUPPORTED_CAPTURE_MIME_TYPES.has(base)
    ? base
    : DEFAULT_CAPTURE_MIME_TYPE;
}

/** ffmpeg in the ASR service selects a demuxer from this file extension. */
export function captureFilename(contentType: string): string {
  switch (contentType) {
    case "audio/ogg":
      return "recording.ogg";
    case "audio/mp4":
      return "recording.m4a";
    case "audio/mpeg":
      return "recording.mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "recording.wav";
    default:
      return "recording.webm";
  }
}
