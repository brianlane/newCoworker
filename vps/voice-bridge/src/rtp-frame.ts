/**
 * Telnyx programmable voice bidirectional streaming with
 * `stream_bidirectional_mode: "rtp"` wraps audio payloads in **RTP packets**
 * (RFC 3550) before base64-encoding them into the JSON `event: "media"` frame.
 *
 * The bridge needs to:
 *   - Strip the 12-byte RTP header on uplink (caller → Gemini), so Gemini
 *     receives clean L16 PCM and not 12 bytes of header garbage every frame.
 *   - Prepend a synthetic 12-byte RTP header on downlink (Gemini → caller)
 *     with a stable SSRC and monotonic sequence/timestamp, otherwise Telnyx
 *     drops the frame — caller hears silence.
 *
 * (May 2026 outage: bridge sat for 32 s on every call accepting the WS but
 *  producing no audio because Gemini saw header-garbled PCM and Telnyx
 *  silently discarded the bridge's bare-PCM downlink frames. The integration
 *  test for L16 RTP echo at team-telnyx/telnyx-samples-pwc round-trips the
 *  payload unchanged, but that only works because echoing replays Telnyx's
 *  own header back — synthesizing audio from scratch requires re-framing.)
 *
 * RTP header layout (12 bytes, all big-endian):
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
 *
 * For L16 mono at 16 kHz Telnyx negotiates a dynamic payload type (96+);
 * the value isn't fixed by RFC 3551 (which assigns PT=11 to L16 at 44.1 kHz
 * stereo). On downlink we mirror whatever PT we observed on the uplink so
 * Telnyx's media plane keeps treating the stream as a single SSRC.
 */

const RTP_HEADER_BYTES = 12;

export type RtpDecoded = {
  /** Audio payload after the 12-byte header, ready to feed Gemini Live. */
  payload: Buffer;
  /**
   * Payload type observed in byte 1 (low 7 bits). We mirror this on
   * downlink so Telnyx accepts the synthetic frames.
   */
  payloadType: number;
};

/**
 * Decode a single base64-encoded Telnyx media payload. When the bytes look
 * like an RTP packet (V=2 in the high two bits of byte 0), strip the header
 * and return the audio. When they don't (legacy / non-bidi-rtp mode), pass
 * through unchanged with a default PT.
 */
export function decodeTelnyxMediaPayload(base64: string): RtpDecoded {
  const buf = Buffer.from(base64, "base64");
  if (buf.length < RTP_HEADER_BYTES) {
    return { payload: buf, payloadType: 11 };
  }
  const versionFlags = buf[0] ?? 0;
  const version = (versionFlags >> 6) & 0x03;
  if (version !== 2) {
    // Not an RTP packet — fall back to treating the whole buffer as audio.
    return { payload: buf, payloadType: 11 };
  }
  const csrcCount = versionFlags & 0x0f;
  const headerLen = RTP_HEADER_BYTES + csrcCount * 4;
  if (buf.length <= headerLen) {
    return { payload: Buffer.alloc(0), payloadType: 11 };
  }
  const payloadType = (buf[1] ?? 0) & 0x7f;
  const payload = buf.subarray(headerLen);
  return { payload, payloadType };
}

/**
 * Per-call RTP encoder: maintains the monotonic sequence + timestamp and
 * a stable SSRC so Telnyx treats every emitted frame as part of the same
 * synthetic RTP stream.
 */
export class RtpEncoder {
  private seq: number;
  private ts: number;
  private readonly ssrc: number;
  private payloadType: number;

  constructor(opts?: { payloadType?: number }) {
    // Random initial seq/ts so collisions across reconnects are unlikely
    // — RFC 3550 §5.1 also recommends randomizing both fields.
    this.seq = Math.floor(Math.random() * 0xffff);
    this.ts = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = Math.floor(Math.random() * 0xffffffff);
    this.payloadType = opts?.payloadType ?? 11;
  }

  /** Mirror the PT observed on the uplink so Telnyx accepts our downlink. */
  public adoptPayloadType(pt: number): void {
    if (pt > 0 && pt < 128) this.payloadType = pt;
  }

  /**
   * Wrap a chunk of L16 PCM (16-bit little-endian samples, mono at the
   * negotiated rate) in an RTP packet. The timestamp advances by the
   * sample count of this frame; that's the conventional RTP clock for
   * uncompressed L16.
   */
  public encode(pcm16le: Int16Array): Buffer {
    const sampleCount = pcm16le.length;
    const audio = Buffer.from(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength);
    const header = Buffer.alloc(RTP_HEADER_BYTES);
    header[0] = 0x80;
    header[1] = this.payloadType & 0x7f;
    header.writeUInt16BE(this.seq, 2);
    header.writeUInt32BE(this.ts >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + sampleCount) >>> 0;
    return Buffer.concat([header, audio]);
  }
}
