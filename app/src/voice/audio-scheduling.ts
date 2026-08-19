export interface AudioPlaybackPlan {
  readonly startAt: number;
  readonly endAt: number;
  readonly underrunMs: number;
}

export interface AudibleWindow {
  readonly offsetSeconds: number;
  readonly durationSeconds: number;
}

export function planAudioPlayback(
  currentTime: number,
  scheduledUntil: number | null,
  durationSeconds: number,
  leadSeconds = 0.04,
  overlapSeconds = 0.018,
): AudioPlaybackPlan {
  const safeCurrentTime = Number.isFinite(currentTime)
    ? Math.max(0, currentTime)
    : 0;
  const safeDuration = Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds)
    : 0;
  const readyAt = safeCurrentTime + Math.max(0, leadSeconds);
  if (scheduledUntil === null || !Number.isFinite(scheduledUntil)) {
    return {
      startAt: readyAt,
      endAt: readyAt + safeDuration,
      underrunMs: 0,
    };
  }

  const previousEnd = Math.max(0, scheduledUntil);
  const continuousStart = Math.max(0, previousEnd - Math.max(0, overlapSeconds));
  const startAt = Math.max(readyAt, continuousStart);
  return {
    startAt,
    endAt: startAt + safeDuration,
    underrunMs: Math.max(0, readyAt - previousEnd) * 1_000,
  };
}

export function findAudibleWindow(
  channels: readonly Float32Array[],
  sampleRate: number,
  threshold = 0.0015,
  paddingSeconds = 0.018,
): AudibleWindow {
  const frameCount = channels[0]?.length ?? 0;
  if (frameCount === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { offsetSeconds: 0, durationSeconds: 0 };
  }

  const isAudible = (frame: number): boolean => {
    for (const channel of channels) {
      if (Math.abs(channel[frame] ?? 0) >= threshold) {
        return true;
      }
    }
    return false;
  };

  let firstAudible = 0;
  while (firstAudible < frameCount && !isAudible(firstAudible)) {
    firstAudible += 1;
  }
  if (firstAudible === frameCount) {
    return { offsetSeconds: 0, durationSeconds: frameCount / sampleRate };
  }

  let lastAudible = frameCount - 1;
  while (lastAudible > firstAudible && !isAudible(lastAudible)) {
    lastAudible -= 1;
  }

  const paddingFrames = Math.max(0, Math.round(paddingSeconds * sampleRate));
  const startFrame = Math.max(0, firstAudible - paddingFrames);
  const endFrame = Math.min(frameCount, lastAudible + paddingFrames + 1);
  return {
    offsetSeconds: startFrame / sampleRate,
    durationSeconds: (endFrame - startFrame) / sampleRate,
  };
}
