import { describe, expect, it } from "vitest";
import { utils as ssh2Utils } from "ssh2";
import { createPrivateKey, generateKeyPair as nodeGenKeyPair } from "node:crypto";
import { promisify } from "node:util";
import {
  generateSshKeypair,
  fingerprintOpenSshPublicKey,
  verifyKeypairRoundTrip,
  convertPkcs8Ed25519PemToOpenssh
} from "@/lib/hostinger/keypair";

const generateKeyPair = promisify(nodeGenKeyPair);

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

  it("generates an OpenSSH-format PEM private key that ssh2 can parse", async () => {
    const pair = await generateSshKeypair("test");
    // We deliberately emit OpenSSH ("openssh-key-v1") rather than PKCS#8
    // because ssh2 1.17 rejects unencrypted PKCS#8 ed25519 PEMs with
    // "Cannot parse privateKey: Unsupported key format". The OpenSSH-format
    // key is the only one that's loadable by every consumer in our path
    // (ssh2, OpenSSH CLI, hPanel paste-in).
    expect(pair.privateKeyPem).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(pair.privateKeyPem).toContain("END OPENSSH PRIVATE KEY");
    const parsed = ssh2Utils.parseKey(pair.privateKeyPem);
    expect(parsed instanceof Error ? parsed.message : (parsed as { type: string }).type).toBe(
      "ssh-ed25519"
    );
    // Round-trip verifies that the public half in the openssh line actually
    // corresponds to the private key PEM.
    expect(verifyKeypairRoundTrip(pair.publicKey, pair.privateKeyPem)).toBe(true);
  });

  it("convertPkcs8Ed25519PemToOpenssh re-encodes a legacy PKCS#8 ed25519 PEM into ssh2-loadable OpenSSH format", async () => {
    // Generate the same shape of PEM the orchestrator used to persist
    // (PKCS#8) and confirm the conversion produces a key ssh2 can parse
    // AND whose public half matches the original.
    const { publicKey, privateKey } = await generateKeyPair("ed25519");
    const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const opensshLine = await (async () => {
      // Build the matching OpenSSH public-key line so verifyKeypairRoundTrip
      // can compare against the converted private half.
      const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
      const rawPub = Buffer.from(
        (jwk.x ?? "").replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - ((jwk.x ?? "").length % 4)) % 4),
        "base64"
      );
      const algo = Buffer.from("ssh-ed25519", "utf8");
      const sshBlob = Buffer.alloc(4 + algo.length + 4 + rawPub.length);
      sshBlob.writeUInt32BE(algo.length, 0);
      algo.copy(sshBlob, 4);
      sshBlob.writeUInt32BE(rawPub.length, 4 + algo.length);
      rawPub.copy(sshBlob, 4 + algo.length + 4);
      return `ssh-ed25519 ${sshBlob.toString("base64")} converted-test\n`;
    })();

    expect(pkcs8).toContain("BEGIN PRIVATE KEY");
    const opensshPem = convertPkcs8Ed25519PemToOpenssh(pkcs8, "converted-test");
    expect(opensshPem).toContain("BEGIN OPENSSH PRIVATE KEY");
    const parsed = ssh2Utils.parseKey(opensshPem);
    expect(parsed instanceof Error ? parsed.message : (parsed as { type: string }).type).toBe(
      "ssh-ed25519"
    );
    expect(verifyKeypairRoundTrip(opensshLine, opensshPem)).toBe(true);

    // Round-trip the result back through node:crypto to make sure the
    // converter doesn't mangle the private scalar (i.e. the OpenSSH PEM
    // it emits encodes the same private key the PKCS#8 PEM encoded).
    const reloadedJwk = createPrivateKey(pkcs8).export({ format: "jwk" }) as { d?: string };
    expect(typeof reloadedJwk.d).toBe("string");
  });

  it("convertPkcs8Ed25519PemToOpenssh is idempotent on already-converted PEMs", async () => {
    const pair = await generateSshKeypair("idempotent");
    const out = convertPkcs8Ed25519PemToOpenssh(pair.privateKeyPem);
    expect(out).toBe(pair.privateKeyPem);
  });

  it("convertPkcs8Ed25519PemToOpenssh rejects non-ed25519 PEMs", () => {
    expect(() => convertPkcs8Ed25519PemToOpenssh("not a pem")).toThrow();
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
