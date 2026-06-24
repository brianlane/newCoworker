/**
 * Stateful linear-interpolation resampler for a CONTINUOUS mono s16le stream.
 *
 * The one-shot `resamplePCM16Mono` below resamples each buffer in isolation:
 * it resets the read phase to 0 and drops the sub-sample remainder at the end
 * of every call. That's fine for a single buffer, but when you feed it a long
 * stream one chunk at a time (e.g. Gemini Live emits many small 24 kHz PCM
 * chunks per second of speech) each chunk boundary gets BOTH a phase reset and
 * a dropped fractional sample. The result is a tiny step discontinuity at every
 * boundary — audible as a periodic click/"typing" sound under the voice.
 *
 * This class fixes that by carrying two pieces of state across `process` calls:
 *
 *   - `pos`  — the fractional read position, expressed in the NEXT chunk's
 *              index space (can be slightly negative, meaning "between the last
 *              sample of the previous chunk and the first of this one").
 *   - `prev` — the final input sample of the previous chunk, used as the left
 *              interpolation neighbour when `pos` lands before this chunk's
 *              sample 0.
 *
 * Output is therefore phase-continuous across chunk boundaries with no dropped
 * samples, which removes the clicking entirely.
 */
export class StreamingResampler {
  private readonly ratio: number;
  private pos = 0;
  private prev = 0;

  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number
  ) {
    this.ratio = inputRate / outputRate;
  }

  /** True when this resampler is configured for the given input rate. */
  matchesRate(inputRate: number): boolean {
    return this.inputRate === inputRate;
  }

  process(input: Int16Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);
    if (this.inputRate === this.outputRate) {
      // Passthrough: keep `prev` current so a later rate change stays continuous.
      this.prev = input[input.length - 1]!;
      return input.slice();
    }
    const n = input.length;
    const ratio = this.ratio;
    const sampleAt = (k: number): number => {
      if (k < 0) return this.prev;
      if (k >= n) return input[n - 1]!;
      return input[k]!;
    };
    // Upper bound on output count; we may emit one fewer. Avoids array growth.
    const out = new Int16Array(Math.max(0, Math.ceil((n - this.pos) / ratio)) + 1);
    let count = 0;
    let p = this.pos;
    while (p <= n - 1) {
      const i0 = Math.floor(p);
      const frac = p - i0;
      const s0 = sampleAt(i0);
      const s1 = sampleAt(i0 + 1);
      const s = s0 + frac * (s1 - s0);
      out[count++] = Math.max(-32768, Math.min(32767, Math.round(s)));
      p += ratio;
    }
    // Carry the read position into the next chunk's coordinate space and
    // remember this chunk's last sample as the next left neighbour.
    this.pos = p - n;
    this.prev = input[n - 1]!;
    return out.subarray(0, count);
  }
}

/** Linear interpolation resample for mono s16le PCM. */
export function resamplePCM16Mono(input: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (inputRate === outputRate || input.length === 0) {
    return input.slice();
  }
  const ratio = inputRate / outputRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLength);
  for (let j = 0; j < outLength; j++) {
    const srcPos = j * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    const s0 = input[i0]!;
    const s1 = input[i1]!;
    const s = s0 + frac * (s1 - s0);
    out[j] = Math.max(-32768, Math.min(32767, Math.round(s)));
  }
  return out;
}

export function parsePcmRateFromMime(mimeType: string | undefined, fallback: number): number {
  if (!mimeType) return fallback;
  const m = /rate=(\d+)/i.exec(mimeType);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}
