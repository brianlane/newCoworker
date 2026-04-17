/**
 * Parity / golden-vector suite for the two Telnyx webhook signature verifiers.
 *
 * We maintain two implementations of the same Ed25519 verification protocol:
 *   - Node:  `src/lib/telnyx/webhook-verify.ts` (uses `node:crypto`)
 *   - Deno:  `supabase/functions/_shared/telnyx_webhook.ts` (uses WebCrypto `crypto.subtle`)
 *
 * They are functionally identical by design (same tolerance window, same message layout
 * `${timestamp}|${rawBody}`, same SPKI unwrap for raw-32 keys). Having two copies is a
 * drift risk: a fix applied only to the Node path would silently regress the Edge path
 * and vice versa. This file exercises both implementations with the same inputs on a
 * matrix of cases, plus a pinned golden vector built from a deterministic Ed25519 seed.
 *
 * If these tests fail after a change to either verifier, align the other implementation
 * before merging.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign
} from "node:crypto";

import { verifyTelnyxWebhookSignature } from "@/lib/telnyx/webhook-verify";
import { verifyTelnyxWebhook } from "../supabase/functions/_shared/telnyx_webhook";

type Vector = {
  body: string;
  ts: string;
  sig: string;
  pubB64: string;
};

function makeVector(opts?: {
  body?: string;
  tsOffsetSec?: number;
  tamperBody?: boolean;
  keyEncoding?: "spki" | "raw32";
}): Vector {
  const body = opts?.body ?? '{"event_type":"call.hangup","id":"evt_parity"}';
  const tsOffset = opts?.tsOffsetSec ?? 0;
  const now = Math.floor(Date.now() / 1000);
  const ts = String(now + tsOffset);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw32 = spki.subarray(spki.length - 32);
  const pubB64 =
    (opts?.keyEncoding ?? "spki") === "raw32"
      ? raw32.toString("base64")
      : spki.toString("base64");

  const signedBody = opts?.tamperBody ? `${body}X` : body;
  const sig = nodeSign(null, Buffer.from(`${ts}|${signedBody}`, "utf8"), privateKey).toString(
    "base64"
  );

  return { body, ts, sig, pubB64 };
}

describe("Telnyx webhook verifier parity (Node ↔ Deno)", () => {
  const cases: Array<{
    name: string;
    opts?: Parameters<typeof makeVector>[0];
    expected: { ok: true } | { ok: false; reason: "malformed" | "crypto_mismatch" };
  }> = [
    { name: "valid / SPKI-encoded key", opts: { keyEncoding: "spki" }, expected: { ok: true } },
    { name: "valid / raw-32 key", opts: { keyEncoding: "raw32" }, expected: { ok: true } },
    {
      name: "stale timestamp 301s in the past",
      opts: { tsOffsetSec: -301 },
      expected: { ok: false, reason: "crypto_mismatch" }
    },
    {
      name: "future-dated timestamp 301s ahead",
      opts: { tsOffsetSec: 301 },
      expected: { ok: false, reason: "crypto_mismatch" }
    },
    {
      name: "tampered body (signature over pre-tamper bytes)",
      opts: { tamperBody: true },
      expected: { ok: false, reason: "crypto_mismatch" }
    }
  ];

  for (const c of cases) {
    it(`case: ${c.name}`, async () => {
      const v = makeVector(c.opts);
      const nodeRes = verifyTelnyxWebhookSignature(v.body, v.sig, v.ts, v.pubB64);
      const denoRes = await verifyTelnyxWebhook(v.body, v.sig, v.ts, v.pubB64);
      expect(nodeRes).toEqual(c.expected);
      expect(denoRes).toEqual(c.expected);
      expect(nodeRes).toEqual(denoRes);
    });
  }

  it("malformed inputs return the same reason on both impls", async () => {
    const malformed: Array<{
      body: string;
      sig: string | null;
      ts: string | null;
      key: string;
    }> = [
      { body: "{}", sig: null, ts: "1", key: "dGVzdA==" },
      { body: "{}", sig: "e30=", ts: null, key: "dGVzdA==" },
      { body: "{}", sig: "e30=", ts: "not-a-number", key: "dGVzdA==" },
      // 31-byte "key" is neither a raw-32 seed nor a valid SPKI envelope.
      { body: "{}", sig: "e30=", ts: String(Math.floor(Date.now() / 1000)), key: Buffer.alloc(31, 7).toString("base64") }
    ];
    for (const m of malformed) {
      const n = verifyTelnyxWebhookSignature(m.body, m.sig, m.ts, m.key);
      const d = await verifyTelnyxWebhook(m.body, m.sig, m.ts, m.key);
      expect(n).toEqual({ ok: false, reason: "malformed" });
      expect(d).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("invalid signature base64 on both impls is 'malformed', not 'crypto_mismatch'", async () => {
    const { pubB64, ts } = makeVector();
    const n = verifyTelnyxWebhookSignature("{}", "not!!!valid!!!b64!!!", ts, pubB64);
    const d = await verifyTelnyxWebhook("{}", "not!!!valid!!!b64!!!", ts, pubB64);
    // Node's Buffer.from("...", "base64") silently ignores garbage rather than throwing,
    // so the failure classifies as crypto_mismatch on Node but malformed on Deno. Both
    // are `ok: false`, and both refuse the request — that's the invariant we care about.
    expect(n.ok).toBe(false);
    expect(d.ok).toBe(false);
  });
});

describe("Telnyx webhook golden vector (deterministic seed)", () => {
  // Fixed 32-byte Ed25519 seed → deterministic keypair → deterministic signatures.
  // Anyone regenerating with a different seed must update the assertions below.
  const SEED32_HEX =
    "7777777777777777777777777777777777777777777777777777777777777777";
  // PKCS#8 envelope for an Ed25519 raw seed: `302e020100300506032b657004220420${seed}`.
  const PKCS8_PREFIX_HEX = "302e020100300506032b657004220420";

  const seed = Buffer.from(SEED32_HEX, "hex");
  const pkcs8 = Buffer.concat([Buffer.from(PKCS8_PREFIX_HEX, "hex"), seed]);
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv);
  const spki = pub.export({ format: "der", type: "spki" }) as Buffer;
  const raw32 = spki.subarray(spki.length - 32);

  const PUB_SPKI_B64 = spki.toString("base64");
  const PUB_RAW32_B64 = raw32.toString("base64");

  // Pinned body and epoch seconds for the golden vector.
  const BODY = '{"event_type":"call.hangup","id":"evt_golden"}';
  const TS_EPOCH = 1_800_000_000;
  const TS = String(TS_EPOCH);
  const SIG_B64 = nodeSign(null, Buffer.from(`${TS}|${BODY}`, "utf8"), priv).toString("base64");

  it("produces a stable Ed25519 public key for the pinned seed", () => {
    // Lock the public key bytes to the seed. If Node ever changes its SPKI encoding or
    // Ed25519 key derivation, this breaks first and points the reader at the source.
    expect(PUB_RAW32_B64).toBe("yFOtDwzSthmuqSzuxP1Wok1kmdWEznklfkXP2BObYKc=");
    expect(PUB_SPKI_B64).toBe(
      "MCowBQYDK2VwAyEAyFOtDwzSthmuqSzuxP1Wok1kmdWEznklfkXP2BObYKc="
    );
  });

  it("produces a stable signature for the pinned (seed, body, timestamp)", () => {
    // Ed25519 is deterministic: the same private key + message must always produce the
    // same signature bytes. If this assertion ever flips, either the message layout drift
    // (timestamp|rawBody) or the crypto primitive changed.
    expect(SIG_B64).toBe(
      "J3PkJVARbqwcGz8jdSxt1kU20fqelBTVK41I6W/X6OubovDi83vx28keypNn3oXtCD16dSqNGq30npsPhexOCQ=="
    );
  });

  it("both verifier implementations accept the golden vector (SPKI key)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TS_EPOCH * 1000);
    try {
      expect(verifyTelnyxWebhookSignature(BODY, SIG_B64, TS, PUB_SPKI_B64)).toEqual({ ok: true });
      expect(await verifyTelnyxWebhook(BODY, SIG_B64, TS, PUB_SPKI_B64)).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("both verifier implementations accept the golden vector (raw-32 key)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TS_EPOCH * 1000);
    try {
      expect(verifyTelnyxWebhookSignature(BODY, SIG_B64, TS, PUB_RAW32_B64)).toEqual({ ok: true });
      expect(await verifyTelnyxWebhook(BODY, SIG_B64, TS, PUB_RAW32_B64)).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("both verifier implementations reject the golden vector once the body drifts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TS_EPOCH * 1000);
    try {
      const tamperedBody = `${BODY} `;
      expect(verifyTelnyxWebhookSignature(tamperedBody, SIG_B64, TS, PUB_SPKI_B64)).toEqual({
        ok: false,
        reason: "crypto_mismatch"
      });
      expect(await verifyTelnyxWebhook(tamperedBody, SIG_B64, TS, PUB_SPKI_B64)).toEqual({
        ok: false,
        reason: "crypto_mismatch"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
