/**
 * Unit tests for the voice-bridge downlink resampler.
 *
 * Gemini Live streams 24 kHz PCM to the bridge in many small, variable-size
 * chunks; the bridge resamples each to Telnyx's 16 kHz and RTP-wraps it. The
 * old one-shot `resamplePCM16Mono` reset its read phase and dropped the
 * sub-sample remainder on every chunk, so each chunk boundary got a step
 * discontinuity — audible as a periodic click/"typing" sound under the voice.
 *
 * `StreamingResampler` carries the phase + previous sample across calls. The
 * defining property is "chunking invariance": feeding a stream in arbitrary
 * chunk sizes must produce the EXACT same samples as feeding it whole. These
 * tests pin that, plus a direct comparison showing the stateless path injects
 * boundary spikes that the streaming path does not.
 */
import { describe, expect, it } from "vitest";
import { resamplePCM16Mono, StreamingResampler } from "../vps/voice-bridge/src/audio-resample";

const IN_RATE = 24000;
const OUT_RATE = 16000;

/** A 440 Hz sine at `rate` Hz, `n` samples, full-ish scale. */
function sine(n: number, rate: number, freq = 440, amp = 30000): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  return out;
}

function concat(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Largest absolute jump between consecutive samples. */
function maxStep(x: Int16Array): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
}

describe("StreamingResampler", () => {
  it("is chunking-invariant: arbitrary chunk splits == whole-buffer output", () => {
    const input = sine(7201, IN_RATE); // deliberately not a multiple of the 1.5 ratio

    const whole = new StreamingResampler(IN_RATE, OUT_RATE).process(input);

    // Uneven chunk sizes that are NOT multiples of 3 stress the fractional carry.
    const chunkSizes = [100, 233, 1, 2, 999, 7, 500, 13];
    const chunked = new StreamingResampler(IN_RATE, OUT_RATE);
    const parts: Int16Array[] = [];
    let off = 0;
    let si = 0;
    while (off < input.length) {
      const size = Math.min(chunkSizes[si % chunkSizes.length]!, input.length - off);
      parts.push(chunked.process(input.subarray(off, off + size)));
      off += size;
      si++;
    }
    const streamed = concat(parts);

    expect(streamed.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(streamed[i]).toBe(whole[i]);
    }
  });

  it("preserves samples and stays smooth where the stateless path drops them", () => {
    const input = sine(6000, IN_RATE);
    const chunkSizes = [101, 99, 100, 103, 97]; // non-3-multiples => fractional drift

    // Stateless: resample each chunk independently (the old behaviour). It does
    // outLen = floor(chunkLen / ratio), so it discards the sub-sample remainder
    // on EVERY chunk — the phase drifts and total samples come up short, which
    // is exactly the glitch the streaming resampler removes.
    const statelessParts: Int16Array[] = [];
    const streaming = new StreamingResampler(IN_RATE, OUT_RATE);
    const streamingParts: Int16Array[] = [];

    let off = 0;
    let si = 0;
    while (off < input.length) {
      const size = Math.min(chunkSizes[si % chunkSizes.length]!, input.length - off);
      const chunk = input.subarray(off, off + size);
      statelessParts.push(resamplePCM16Mono(chunk, IN_RATE, OUT_RATE));
      streamingParts.push(streaming.process(chunk));
      off += size;
      si++;
    }

    const stateless = concat(statelessParts);
    const streamed = concat(streamingParts);
    const ideal = input.length * (OUT_RATE / IN_RATE); // 4000

    // Streaming keeps (nearly) every sample; stateless leaks samples per chunk.
    expect(Math.abs(streamed.length - ideal)).toBeLessThanOrEqual(1);
    expect(streamed.length).toBeGreaterThan(stateless.length);

    // And the streaming output stays within the natural smoothness bound of a
    // 440 Hz sine at 16 kHz (no boundary spikes).
    const naturalStep = maxStep(sine(4000, OUT_RATE));
    expect(maxStep(streamed)).toBeLessThan(naturalStep * 1.5);
  });

  it("passes audio through unchanged when input and output rates match", () => {
    const input = sine(800, OUT_RATE);
    const r = new StreamingResampler(OUT_RATE, OUT_RATE);
    const out = r.process(input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("produces roughly inputLength / ratio samples over the stream", () => {
    const input = sine(48000, IN_RATE); // 2 s of 24 kHz audio
    const r = new StreamingResampler(IN_RATE, OUT_RATE);
    let produced = 0;
    for (let off = 0; off < input.length; off += 320) {
      produced += r.process(input.subarray(off, off + 320)).length;
    }
    const expected = input.length * (OUT_RATE / IN_RATE); // 32000
    expect(Math.abs(produced - expected)).toBeLessThanOrEqual(2);
  });

  it("matchesRate reflects the configured input rate", () => {
    const r = new StreamingResampler(IN_RATE, OUT_RATE);
    expect(r.matchesRate(IN_RATE)).toBe(true);
    expect(r.matchesRate(48000)).toBe(false);
  });
});
