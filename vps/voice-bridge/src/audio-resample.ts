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
