import { describe, expect, it } from "vitest";
import {
  generateSshKeypair,
  fingerprintOpenSshPublicKey,
  verifyKeypairRoundTrip
} from "@/lib/hostinger/keypair";

describe("ssh keypair", () => {
  it("generates a valid OpenSSH ed25519 public key line", async () => {
    const pair = await generateSshKeypair("newcoworker-abc-def");
    expect(pair.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    const parts = pair.publicKey.trim().split(/\s+/);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("ssh-ed25519");
    expect(parts[2]).toBe("newcoworker-abc-def");
    // base64 blob is 68 chars (51 bytes decoded: 4+11+4+32)
    expect(Buffer.from(parts[1], "base64").length).toBe(51);
  });

  it("generates a PKCS#8 PEM private key that loads in node:crypto", async () => {
    const pair = await generateSshKeypair("test");
    expect(pair.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(pair.privateKeyPem).toContain("END PRIVATE KEY");
    // Round-trip verifies that the public half in the openssh line actually
    // corresponds to the private key PEM.
    expect(verifyKeypairRoundTrip(pair.publicKey, pair.privateKeyPem)).toBe(true);
  });

  it("returns a SHA256 fingerprint matching fingerprintOpenSshPublicKey", async () => {
    const pair = await generateSshKeypair("test");
    const fp2 = await fingerprintOpenSshPublicKey(pair.publicKey);
    expect(fp2).toBe(pair.fingerprintSha256);
    expect(pair.fingerprintSha256.startsWith("SHA256:")).toBe(true);
  });

  it("sanitises newline/tab chars out of the comment", async () => {
    const pair = await generateSshKeypair("bad\n\tcomment");
    // The comment segment should collapse to a single space-joined token.
    const parts = pair.publicKey.trim().split(/\s+/);
    expect(parts[2]).toBe("bad");
    // Second line of original comment ("comment") becomes the next token, not a new line.
    expect(parts[3]).toBe("comment");
  });

  it("falls back to 'newcoworker' when the comment is empty after sanitisation", async () => {
    const pair = await generateSshKeypair("   \n\t  ");
    const parts = pair.publicKey.trim().split(/\s+/);
    expect(parts[2]).toBe("newcoworker");
  });

  it("fingerprintOpenSshPublicKey rejects non-ed25519 keys", async () => {
    await expect(fingerprintOpenSshPublicKey("ssh-rsa AAAAFOO")).rejects.toThrow(/ssh-ed25519/);
  });

  it("verifyKeypairRoundTrip returns false when the public key doesn't match", async () => {
    const a = await generateSshKeypair("a");
    const b = await generateSshKeypair("b");
    expect(verifyKeypairRoundTrip(a.publicKey, b.privateKeyPem)).toBe(false);
  });

  it("verifyKeypairRoundTrip returns false for malformed private key PEM", () => {
    expect(verifyKeypairRoundTrip("ssh-ed25519 AAA", "not a pem")).toBe(false);
  });

  it("verifyKeypairRoundTrip returns false for malformed public-key line", async () => {
    const p = await generateSshKeypair("t");
    expect(verifyKeypairRoundTrip("malformed", p.privateKeyPem)).toBe(false);
  });
});
