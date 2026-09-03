/**
 * Mailbox-beep detector on the uplink L16 16 kHz PCM the voice bridge already
 * holds. Telnyx `greeting.ended result=beep_detected` is the honest speak
 * trigger, and it is missing on human_* false negatives and on calls where
 * Telnyx never runs beep detection. This is the bridge-side backstop.
 *
 * A voicemail beep is a SINGLE mid-band tone that holds, then drops. That is
 * a different shape from speech, from DTMF (two tones at once), from a click,
 * and from a long fax/hold tone. False negatives fall through to the AMD
 * resolution sweep. False positives on an Apple screening tone are the
 * Robert failure with a different trigger, so the GATE in
 * `shouldSpeakOnBridgeBeep` (voicemail-mode.ts) is load-bearing: this module
 * only answers "was that a beep", never "should we speak".
 */

export const BEEP_SAMPLE_RATE = 16_000;
/** 20 ms frames, matching Telnyx's negotiated L16 cadence. */
export const BEEP_FRAME_SAMPLES = 320;
/** Shortest sustain that still looks like a mailbox tone, not a click. */
export const BEEP_MIN_TONE_MS = 200;
/** Longer than this is a continuous tone (fax, hold), not a beep. */
export const BEEP_MAX_TONE_MS = 1_500;

const MIN_TONE_FRAMES = Math.ceil((BEEP_MIN_TONE_MS / 1000) * (BEEP_SAMPLE_RATE / BEEP_FRAME_SAMPLES));
const MAX_TONE_FRAMES = Math.floor((BEEP_MAX_TONE_MS / 1000) * (BEEP_SAMPLE_RATE / BEEP_FRAME_SAMPLES));

/** Goertzel bins covering the mailbox-beep band. */
const BEEP_FREQS = [400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500];

const MIN_RMS = 0.04;
const DOMINANCE = 0.42;
const SECOND_PEAK_RATIO = 0.55;

export type BeepDetector = {
  /** Feed uplink PCM. Returns true once, at the moment a beep completes (tone then drop). */
  push(samples: Int16Array): boolean;
};

function goertzelPower(frame: Float64Array, freq: number): number {
  const n = frame.length;
  const k = Math.round((n * freq) / BEEP_SAMPLE_RATE);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = frame[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(omega);
  const imag = s2 * Math.sin(omega);
  return real * real + imag * imag;
}

function frameIsTone(frame: Float64Array): boolean {
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i]! * frame[i]!;
  const rms = Math.sqrt(energy / frame.length);
  if (rms < MIN_RMS) return false;

  let maxPower = 0;
  let second = 0;
  let sum = 0;
  for (const freq of BEEP_FREQS) {
    const p = goertzelPower(frame, freq);
    sum += p;
    if (p > maxPower) {
      second = maxPower;
      maxPower = p;
    } else if (p > second) {
      second = p;
    }
  }
  if (sum <= 0) return false;
  if (maxPower / sum < DOMINANCE) return false;
  if (maxPower > 0 && second / maxPower > SECOND_PEAK_RATIO) return false;
  return true;
}

function toFloatFrame(samples: Int16Array, offset: number, length: number): Float64Array {
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = (samples[offset + i] ?? 0) / 32768;
  return out;
}

/**
 * Incremental detector. Buffers to 20 ms frames so a Telnyx packet of any
 * size still sees the same sustain clock. Fires once per burst (tone of
 * 200-1500 ms followed by a drop) and then resets, so a mailbox that beeps
 * twice can still be caught on the second tone.
 */
export function createBeepDetector(): BeepDetector {
  let leftover = new Int16Array(0);
  let toneFrames = 0;
  let awaitingDrop = false;

  const resetBurst = () => {
    toneFrames = 0;
    awaitingDrop = false;
  };

  return {
    push(samples: Int16Array): boolean {
      if (samples.length === 0) return false;
      const combined = new Int16Array(leftover.length + samples.length);
      combined.set(leftover, 0);
      combined.set(samples, leftover.length);
      let offset = 0;
      let fired = false;
      while (offset + BEEP_FRAME_SAMPLES <= combined.length) {
        const frame = toFloatFrame(combined, offset, BEEP_FRAME_SAMPLES);
        offset += BEEP_FRAME_SAMPLES;
        const tonal = frameIsTone(frame);
        if (awaitingDrop) {
          if (!tonal) {
            fired = true;
            resetBurst();
          } else if (toneFrames >= MAX_TONE_FRAMES) {
            // Continuous tone: not a beep.
            resetBurst();
          } else {
            toneFrames += 1;
          }
          continue;
        }
        if (tonal) {
          toneFrames += 1;
          if (toneFrames >= MIN_TONE_FRAMES) awaitingDrop = true;
        } else {
          resetBurst();
        }
      }
      leftover = combined.subarray(offset).slice();
      return fired;
    }
  };
}
