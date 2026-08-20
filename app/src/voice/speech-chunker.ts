export interface StreamingSpeechChunkerOptions {
  firstMinChars?: number;
  firstTargetChars?: number;
  subsequentMinChars?: number;
  subsequentTargetChars?: number;
  hardMaxChars?: number;
}

/**
 * Turns incrementally streamed text into TTS-sized phrases.
 *
 * The implementation deliberately has no runtime dependencies. The browser
 * voice page embeds this class with `StreamingSpeechChunker.toString()`.
 */
export const StreamingSpeechChunker = (() => class {
  private buffer = "";
  private emittedChunks = 0;
  private finished = false;
  private readonly firstMinChars: number;
  private readonly firstTargetChars: number;
  private readonly subsequentMinChars: number;
  private readonly subsequentTargetChars: number;
  private readonly hardMaxChars: number;

  constructor(options: StreamingSpeechChunkerOptions = {}) {
    this.firstMinChars = Math.max(1, options.firstMinChars ?? 28);
    this.firstTargetChars = Math.max(
      this.firstMinChars,
      options.firstTargetChars ?? 56,
    );
    this.subsequentMinChars = Math.max(
      this.firstMinChars,
      options.subsequentMinChars ?? 64,
    );
    this.subsequentTargetChars = Math.max(
      this.subsequentMinChars,
      options.subsequentTargetChars ?? 112,
    );
    this.hardMaxChars = Math.max(
      this.firstTargetChars,
      this.subsequentTargetChars,
      options.hardMaxChars ?? 176,
    );
  }

  push(delta: string): string[] {
    if (this.finished) {
      throw new Error("Cannot push text after finish(); call reset() first.");
    }
    if (delta.length === 0) return [];

    this.buffer = (this.buffer + delta).trimStart();
    const ready: string[] = [];

    while (this.buffer.length > 0) {
      const cutAt = this.findCut();
      if (cutAt === null) break;

      const chunk = this.buffer.slice(0, cutAt).trim();
      this.buffer = this.buffer.slice(cutAt).trimStart();
      if (chunk.length > 0) {
        ready.push(chunk);
        this.emittedChunks += 1;
      }
    }

    return ready;
  }

  finish(): string[] {
    if (this.finished) return [];
    this.finished = true;

    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail.length === 0) return [];

    this.emittedChunks += 1;
    return [tail];
  }

  reset(): void {
    this.buffer = "";
    this.emittedChunks = 0;
    this.finished = false;
  }

  private findCut(): number | null {
    const minimum =
      this.emittedChunks === 0
        ? this.firstMinChars
        : this.subsequentMinChars;
    const target =
      this.emittedChunks === 0
        ? this.firstTargetChars
        : this.subsequentTargetChars;

    const terminalCut = this.findTerminalCut(minimum);
    if (terminalCut !== null && terminalCut <= this.hardMaxChars) {
      return terminalCut;
    }

    if (this.buffer.length >= target) {
      const clauseCut = this.findClauseCut(minimum, target);
      if (clauseCut !== null) return clauseCut;

      const hasCompleteTrailingWord = /\s$/.test(this.buffer);
      const targetLookahead = Math.min(this.hardMaxChars, target + 12);
      if (hasCompleteTrailingWord || this.buffer.length >= targetLookahead) {
        const wordCut = this.findTargetWordCut(minimum, target);
        if (wordCut !== null) return wordCut;
      }
    }

    if (this.buffer.length > this.hardMaxChars) {
      return this.findHardCut();
    }

    return null;
  }

  private findTerminalCut(minimum: number): number | null {
    const boundary = /[.!?]+["'\u2019\u201d)\]}]*(?=\s|$)/g;
    let match: RegExpExecArray | null;

    while ((match = boundary.exec(this.buffer)) !== null) {
      const cutAt = match.index + match[0].length;
      if (this.buffer.slice(0, cutAt).trim().length >= minimum) {
        return cutAt;
      }
    }

    return null;
  }

  private findClauseCut(minimum: number, target: number): number | null {
    const boundary = /[,;:\u2014\u2013-](?=\s)/g;
    let match: RegExpExecArray | null;
    let bestCut: number | null = null;
    let firstAfterTarget: number | null = null;

    while ((match = boundary.exec(this.buffer)) !== null) {
      const cutAt = match.index + match[0].length;
      const length = this.buffer.slice(0, cutAt).trim().length;
      if (length < minimum) continue;
      if (cutAt > this.hardMaxChars) break;
      if (cutAt <= target) {
        bestCut = cutAt;
      } else {
        firstAfterTarget = cutAt;
        break;
      }
    }

    return bestCut ?? firstAfterTarget;
  }

  private findTargetWordCut(minimum: number, target: number): number | null {
    const lastCandidate = Math.min(target, this.buffer.length - 1);
    for (let index = lastCandidate; index >= minimum; index -= 1) {
      if (/\s/.test(this.buffer[index] ?? "")) return index;
    }

    // A large streaming delta can already contain the end of the word that
    // crossed the target. Prefer that nearby boundary to waiting for the hard
    // maximum, while never treating the buffer's unfinished final word as a
    // safe cut.
    const firstCandidate = Math.max(target + 1, minimum);
    const upperBound = Math.min(this.hardMaxChars, this.buffer.length - 1);
    for (let index = firstCandidate; index <= upperBound; index += 1) {
      if (/\s/.test(this.buffer[index] ?? "")) return index;
    }

    return null;
  }

  private findHardCut(): number {
    for (let index = this.hardMaxChars; index > 0; index -= 1) {
      if (/\s/.test(this.buffer[index] ?? "")) return index;
    }

    // A single pathological token has no word boundary. Splitting it is safer
    // than allowing an unbounded TTS request.
    return this.hardMaxChars;
  }
})();
