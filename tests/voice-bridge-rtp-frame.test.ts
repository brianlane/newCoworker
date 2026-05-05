/**
 * Unit tests for the voice-bridge RTP framing helpers.
 *
 * The bridge sits between Telnyx (which uses RTP-over-WebSocket-JSON for
 * `stream_bidirectional_mode: "rtp"` audio) and Gemini Live (which wants
 * clean L16 PCM). The decode/encode helpers in `vps/voice-bridge/src/rtp-frame.ts`
 * are the only thing standing between us and either:
 *   - shipping header bytes to Gemini (uplink garble), or
 *   - shipping bare PCM to Telnyx (Telnyx silently drops it, caller hears
 *     silence — the May 2026 outage).
 *
 * RTP layout reference (RFC 3550 §5.1):
 *
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |V=2|P|X|  CC   |M|     PT      |       sequence number         |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                           timestamp                           |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |           synchronization source (SSRC) identifier            |
 *  +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
 */

import { describe, expect, it } from "vitest";
import {
  decodeTelnyxMediaPayload,
  RtpEncoder
} from "../vps/voice-bridge/src/rtp-frame";

function buildRtpPacket(opts: {
  version?: number;
  padding?: boolean;
  extension?: boolean;
  csrcCount?: number;
  payloadType?: number;
  seq?: number;
  ts?: number;
  ssrc?: number;
  extProfile?: number;
  extWords?: number;
  extData?: Buffer;
  payload: Buffer;
  paddingBytes?: number;
}): Buffer {
  const version = opts.version ?? 2;
  const padding = opts.padding ?? false;
  const extension = opts.extension ?? false;
  const csrcCount = opts.csrcCount ?? 0;
  const pt = opts.payloadType ?? 96;
  const flags =
    ((version & 0x03) << 6) |
    ((padding ? 1 : 0) << 5) |
    ((extension ? 1 : 0) << 4) |
    (csrcCount & 0x0f);

  const header = Buffer.alloc(12);
  header[0] = flags;
  header[1] = pt & 0x7f;
  header.writeUInt16BE(opts.seq ?? 0, 2);
  header.writeUInt32BE(opts.ts ?? 0, 4);
  header.writeUInt32BE(opts.ssrc ?? 0, 8);

  const csrcBlock = Buffer.alloc(csrcCount * 4);

  let extBlock = Buffer.alloc(0);
  if (extension) {
    const words = opts.extWords ?? 0;
    extBlock = Buffer.alloc(4 + words * 4);
    extBlock.writeUInt16BE(opts.extProfile ?? 0xbede, 0);
    extBlock.writeUInt16BE(words, 2);
    if (opts.extData && opts.extData.length === words * 4) {
      opts.extData.copy(extBlock, 4);
    }
  }

  let payload = opts.payload;
  if (padding && opts.paddingBytes && opts.paddingBytes > 0) {
    const padBuf = Buffer.alloc(opts.paddingBytes);
    padBuf[opts.paddingBytes - 1] = opts.paddingBytes;
    payload = Buffer.concat([payload, padBuf]);
  }

  return Buffer.concat([header, csrcBlock, extBlock, payload]);
}

describe("decodeTelnyxMediaPayload", () => {
  it("strips the 12-byte fixed header for a vanilla RTP packet", () => {
    const audio = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const packet = buildRtpPacket({ payload: audio });
    const out = decodeTelnyxMediaPayload(packet.toString("base64"));
    expect(out.payload.equals(audio)).toBe(true);
    expect(out.payloadType).toBe(96);
  });

  it("respects the CSRC count when computing header length", () => {
    const audio = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const packet = buildRtpPacket({ csrcCount: 2, payload: audio });
    const out = decodeTelnyxMediaPayload(packet.toString("base64"));
    expect(out.payload.equals(audio)).toBe(true);
  });

  it("skips the extension header when X=1 (RFC 3550 §5.3.1)", () => {
    // Extension carries 2x32-bit words = 8 bytes of "junk" that must NOT
    // make it into the audio stream forwarded to Gemini Live.
    const audio = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    const extData = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const packet = buildRtpPacket({
      extension: true,
      extWords: 2,
      extData,
      payload: audio
    });
    const out = decodeTelnyxMediaPayload(packet.toString("base64"));
    expect(out.payload.equals(audio)).toBe(true);
    expect(out.payloadType).toBe(96);
  });

  it("skips a zero-word extension header (X=1, length=0 — header only)", () => {
    const audio = Buffer.from([0x99]);
    const packet = buildRtpPacket({
      extension: true,
      extWords: 0,
      payload: audio
    });
    const out = decodeTelnyxMediaPayload(packet.toString("base64"));
    expect(out.payload.equals(audio)).toBe(true);
  });

  it("handles X=1 + CSRC together (extension follows the CSRC list)", () => {
    const audio = Buffer.from([0x55, 0x66]);
    const packet = buildRtpPacket({
      csrcCount: 1,
      extension: true,
      extWords: 1,
      extData: Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
      payload: audio
    });
    const out = decodeTelnyxMediaPayload(packet.toString("base64"));
    expect(out.payload.equals(audio)).toBe(true);
  });

  it("returns empty payload + observed PT when X=1 but the packet is too short for the ext header", () => {
    // 12-byte header, X=1, but no extension header bytes follow.
    const truncated = buildRtpPacket({ extension: true, payload: Buffer.alloc(0) }).subarray(0, 12);
    const out = decodeTelnyxMediaPayload(truncated.toString("base64"));
    expect(out.payload.length).toBe(0);
    expect(out.payloadType).toBe(96);
  });

  it("strips trailing padding when P=1 (RFC 3550 §5.1)", () => {
    const audio = Buffer.from([0x01, 0x02, 0x03]);
    const packet = buildRtpPacket({
      padding: true,
      paddingBytes: 4,
      payload: audio
    });
    const out = decodeTelnyxMediaPayload(packet.toString("base64"));
    expect(out.payload.equals(audio)).toBe(true);
  });

  it("ignores nonsensical pad-count (>= payload.length) rather than corrupting the buffer", () => {
    // Hand-roll: P=1, but the last byte claims more padding than exists.
    const header = Buffer.alloc(12);
    header[0] = (2 << 6) | (1 << 5);
    header[1] = 96;
    const payload = Buffer.from([0x01, 0x02, 0xff]); // pad-count says 255
    const packet = Buffer.concat([header, payload]);
    const out = decodeTelnyxMediaPayload(packet.toString("base64"));
    expect(out.payload.equals(payload)).toBe(true);
  });

  it("falls back to passthrough when version != 2 (legacy / non-RTP frame)", () => {
    const buf = Buffer.from([0x00, 0x00, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
    const out = decodeTelnyxMediaPayload(buf.toString("base64"));
    expect(out.payload.equals(buf)).toBe(true);
    expect(out.payloadType).toBe(11);
  });

  it("falls back to passthrough when buffer is shorter than 12 bytes", () => {
    const tiny = Buffer.from([1, 2, 3]);
    const out = decodeTelnyxMediaPayload(tiny.toString("base64"));
    expect(out.payload.equals(tiny)).toBe(true);
    expect(out.payloadType).toBe(11);
  });

  it("returns empty payload when the buffer ends exactly at headerLen", () => {
    const headerOnly = buildRtpPacket({ payload: Buffer.alloc(0) });
    const out = decodeTelnyxMediaPayload(headerOnly.toString("base64"));
    expect(out.payload.length).toBe(0);
  });
});

describe("RtpEncoder", () => {
  it("prepends a 12-byte header on encode and advances seq + ts", () => {
    const enc = new RtpEncoder({ payloadType: 96 });
    const samples = new Int16Array([100, -200, 300, -400]);
    const frame = enc.encode(samples);
    expect(frame.length).toBe(12 + samples.byteLength);
    expect(((frame[0] ?? 0) >> 6) & 0x03).toBe(2); // V=2
    expect((frame[1] ?? 0) & 0x7f).toBe(96);

    const seqA = frame.readUInt16BE(2);
    const tsA = frame.readUInt32BE(4);
    const ssrcA = frame.readUInt32BE(8);

    const next = enc.encode(samples);
    expect(next.readUInt16BE(2)).toBe((seqA + 1) & 0xffff);
    expect(next.readUInt32BE(4)).toBe((tsA + samples.length) >>> 0);
    // SSRC must be stable across frames so Telnyx treats them as one stream.
    expect(next.readUInt32BE(8)).toBe(ssrcA);
  });

  it("clamps adoptPayloadType to 1..127 (PT spans 7 bits)", () => {
    const enc = new RtpEncoder({ payloadType: 11 });
    enc.adoptPayloadType(0); // out of range — keep current
    expect((enc.encode(new Int16Array([0]))[1] ?? 0) & 0x7f).toBe(11);

    enc.adoptPayloadType(128); // out of range — keep current
    expect((enc.encode(new Int16Array([0]))[1] ?? 0) & 0x7f).toBe(11);

    enc.adoptPayloadType(96);
    expect((enc.encode(new Int16Array([0]))[1] ?? 0) & 0x7f).toBe(96);
  });

  it("payloadType defaults to 11 when no opts provided", () => {
    const enc = new RtpEncoder();
    const frame = enc.encode(new Int16Array([1, 2]));
    expect((frame[1] ?? 0) & 0x7f).toBe(11);
  });

  it("encodes 16-bit LE samples in their original byte order", () => {
    const enc = new RtpEncoder();
    const samples = new Int16Array([0x1234, -1]);
    const frame = enc.encode(samples);
    const audio = frame.subarray(12);
    // Int16Array stores host-endian; on x86/arm this is LE — Telnyx
    // negotiates L16 LE on bidi streams. Just check we forwarded the
    // underlying bytes verbatim, which is what the encoder is documented
    // to do.
    expect(audio.equals(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))).toBe(true);
  });

  it("seq wraps at 0xffff", () => {
    const enc = new RtpEncoder();
    // Burn a near-overflow seq deterministically by reaching into the
    // private state via type assertion. (Public API alone can't reach
    // 0xffff in a unit test without hammering 65k calls.)
    (enc as unknown as { seq: number }).seq = 0xffff;
    const a = enc.encode(new Int16Array([1]));
    const b = enc.encode(new Int16Array([1]));
    expect(a.readUInt16BE(2)).toBe(0xffff);
    expect(b.readUInt16BE(2)).toBe(0);
  });
});
