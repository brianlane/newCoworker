import { describe, expect, it } from "vitest";
import {
  BEEP_FRAME_SAMPLES,
  BEEP_SAMPLE_RATE,
  createBeepDetector
} from "../vps/voice-bridge/src/beep-detector";

function sine(freqHz: number, durationMs: number, amplitude = 0.5): Int16Array {
  const n = Math.round((BEEP_SAMPLE_RATE * durationMs) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freqHz * i) / BEEP_SAMPLE_RATE));
  }
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function silence(durationMs: number): Int16Array {
  return new Int16Array(Math.round((BEEP_SAMPLE_RATE * durationMs) / 1000));
}

function feed(samples: Int16Array): boolean {
  const det = createBeepDetector();
  let fired = false;
  for (let i = 0; i < samples.length; i += BEEP_FRAME_SAMPLES) {
    const end = Math.min(i + BEEP_FRAME_SAMPLES, samples.length);
    if (det.push(samples.subarray(i, end))) fired = true;
  }
  return fired;
}

function noise(durationMs: number, seed = 1): Int16Array {
  const n = Math.round((BEEP_SAMPLE_RATE * durationMs) / 1000);
  const out = new Int16Array(n);
  let s = seed;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const white = (s / 0x7fffffff) * 2 - 1;
    lp = 0.95 * lp + 0.05 * white;
    out[i] = Math.round(lp * 12000);
  }
  return out;
}

function dtmf(durationMs: number): Int16Array {
  const n = Math.round((BEEP_SAMPLE_RATE * durationMs) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.sin((2 * Math.PI * 697 * i) / BEEP_SAMPLE_RATE);
    const b = Math.sin((2 * Math.PI * 1209 * i) / BEEP_SAMPLE_RATE);
    out[i] = Math.round(0.4 * 32767 * (a + b) * 0.5);
  }
  return out;
}

describe("beep detector", () => {
  it("fires on a 400-1500 Hz tone that holds then drops", () => {
    for (const freq of [400, 800, 1000, 1500]) {
      expect(feed(concat(sine(freq, 300), silence(80))), `${freq} Hz`).toBe(true);
    }
  });

  it("rejects speech-shaped noise, DTMF pairs, short clicks, and a sub-80ms blip", () => {
    expect(feed(concat(noise(500), silence(80)))).toBe(false);
    expect(feed(concat(dtmf(400), silence(80)))).toBe(false);
    const click = new Int16Array(BEEP_FRAME_SAMPLES);
    click[4] = 30000;
    expect(feed(concat(click, silence(200)))).toBe(false);
    expect(feed(concat(sine(1000, 70), silence(200)))).toBe(false);
  });

  it("rejects a tone that never drops (fax/hold)", () => {
    expect(feed(sine(1000, 2000))).toBe(false);
  });

  it("can fire twice when a mailbox beeps, waits, then beeps again", () => {
    const det = createBeepDetector();
    const first = concat(sine(1000, 300), silence(100));
    const second = concat(sine(1000, 300), silence(100));
    let fires = 0;
    for (const burst of [first, second]) {
      for (let i = 0; i < burst.length; i += BEEP_FRAME_SAMPLES) {
        if (det.push(burst.subarray(i, Math.min(i + BEEP_FRAME_SAMPLES, burst.length)))) {
          fires += 1;
        }
      }
    }
    expect(fires).toBe(2);
  });

  it("returns false on an empty push and still works after leftover PCM", () => {
    const det = createBeepDetector();
    expect(det.push(new Int16Array(0))).toBe(false);
    expect(det.push(sine(1000, 10))).toBe(false);
    const rest = concat(sine(1000, 300), silence(80));
    let fired = false;
    for (let i = 0; i < rest.length; i += BEEP_FRAME_SAMPLES) {
      if (det.push(rest.subarray(i, Math.min(i + BEEP_FRAME_SAMPLES, rest.length)))) fired = true;
    }
    expect(fired).toBe(true);
  });
});
