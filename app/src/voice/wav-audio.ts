const PCM_FORMAT_TAG = 1;

export interface WavPcm16Audio {
  readonly sampleRate: number;
  readonly channels: number;
  /** Interleaved little-endian 16-bit samples with no container. */
  readonly samples: Uint8Array;
  readonly durationMs: number;
}

interface WavChunks {
  readonly formatTag?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly byteRate?: number;
  readonly bitsPerSample?: number;
  readonly data?: Uint8Array;
}

/**
 * Strips the RIFF container from linear 16-bit PCM WAV audio.
 *
 * Sending raw PCM over the voice socket lets the browser build an AudioBuffer
 * synchronously instead of paying an asynchronous container decode per chunk.
 * Anything that is not PCM16 returns undefined so the caller can fall back to
 * forwarding the original WAV bytes.
 */
export function parseWavPcm16(audio: Uint8Array): WavPcm16Audio | undefined {
  const chunks = readWavChunks(audio);
  if (
    chunks.formatTag !== PCM_FORMAT_TAG ||
    chunks.bitsPerSample !== 16 ||
    !chunks.channels ||
    !chunks.sampleRate ||
    !chunks.data ||
    chunks.data.byteLength === 0
  ) {
    return undefined;
  }

  const bytesPerFrame = chunks.channels * 2;
  const frames = Math.floor(chunks.data.byteLength / bytesPerFrame);
  if (frames === 0) {
    return undefined;
  }

  return {
    sampleRate: chunks.sampleRate,
    channels: chunks.channels,
    samples: chunks.data.subarray(0, frames * bytesPerFrame),
    durationMs: (frames / chunks.sampleRate) * 1_000,
  };
}

/** Duration of any PCM-rate WAV payload, including formats this app cannot unwrap. */
export function wavDurationMs(audio: Uint8Array): number | undefined {
  const chunks = readWavChunks(audio);
  if (!chunks.byteRate || !chunks.data) {
    return undefined;
  }
  return (chunks.data.byteLength / chunks.byteRate) * 1_000;
}

export function hasWavHeader(audio: Uint8Array): boolean {
  return (
    audio.byteLength >= 12 &&
    readFourCc(audio, 0) === "RIFF" &&
    readFourCc(audio, 8) === "WAVE"
  );
}

function readWavChunks(audio: Uint8Array): WavChunks {
  if (!hasWavHeader(audio)) {
    return {};
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let chunks: WavChunks = {};
  let offset = 12;

  while (offset + 8 <= audio.byteLength) {
    const chunkType = readFourCc(audio, offset);
    const declaredSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    const availableSize = Math.min(
      declaredSize,
      audio.byteLength - bodyOffset,
    );

    if (chunkType === "fmt " && availableSize >= 16) {
      chunks = {
        ...chunks,
        formatTag: view.getUint16(bodyOffset, true),
        channels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        byteRate: view.getUint32(bodyOffset + 8, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      };
    } else if (chunkType === "data") {
      chunks = {
        ...chunks,
        data: audio.subarray(bodyOffset, bodyOffset + availableSize),
      };
    }

    if (chunks.data && chunks.formatTag !== undefined) {
      return chunks;
    }

    const paddedSize = declaredSize + (declaredSize % 2);
    if (paddedSize > audio.byteLength - bodyOffset) {
      break;
    }
    offset = bodyOffset + paddedSize;
  }

  return chunks;
}

function readFourCc(audio: Uint8Array, offset: number): string {
  return String.fromCharCode(
    audio[offset] ?? 0,
    audio[offset + 1] ?? 0,
    audio[offset + 2] ?? 0,
    audio[offset + 3] ?? 0,
  );
}
