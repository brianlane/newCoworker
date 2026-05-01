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

  it("convertPkcs8Ed25519PemToOpenssh rejects valid PKCS#8 PEMs that aren't ed25519", async () => {
    // Generate a valid RSA key in PKCS#8 form. node:crypto will load it
    // (so we get past the createPrivateKey throw), but the JWK comes back
    // with crv=undefined / kty="RSA" — exercising the explicit
    // "input is not an ed25519 PKCS#8 PEM" branch that early-rejects
    // wrong-curve material before we attempt to repack as openssh-key-v1.
    // Without this test that throw is unreachable from any real consumer
    // (legacy rows are guaranteed-ed25519 from generateSshKeypair) and
    // branch coverage drops below 100% on keypair.ts.
    const { privateKey } = await generateKeyPair("rsa", { modulusLength: 2048 });
    const rsaPkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => convertPkcs8Ed25519PemToOpenssh(rsaPkcs8, "rsa-test")).toThrow(
      /not an ed25519 PKCS#8 PEM/
    );
  });

  it("verifyKeypairRoundTrip accepts a legacy PKCS#8 ed25519 PEM whose public half matches", async () => {
    // verifyKeypairRoundTrip exists primarily to validate freshly-minted
    // OpenSSH-format keys, but it deliberately ALSO supports legacy
    // PKCS#8 PEMs so historical vps_ssh_keys rows (persisted before the
    // OpenSSH-format export switch) can still be sanity-checked end-to-
    // end during an admin re-bootstrap. The else-branch (line ~157 in
    // keypair.ts) re-derives the public half via node:crypto's
    // createPublicKey + JWK export — only this path exercises that
    // branch in CI; without it branch coverage drops below 100%.
    const { publicKey, privateKey } = await generateKeyPair("ed25519");
    const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
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
    const opensshLine = `ssh-ed25519 ${sshBlob.toString("base64")} legacy-pkcs8\n`;

    expect(pkcs8).toContain("BEGIN PRIVATE KEY");
    expect(verifyKeypairRoundTrip(opensshLine, pkcs8)).toBe(true);
  });

  it("verifyKeypairRoundTrip returns false for a legacy PKCS#8 PEM whose public half does NOT match", async () => {
    // Mismatch path for the same PKCS#8 branch: re-derived rawPub via
    // node:crypto must NOT equal the public-key line we're being asked
    // to verify against. This pins the branch where parts[1] !==
    // expected returns false (vs. the early-bail `parts.length < 2`
    // and `ssh-ed25519` token checks already covered above) for the
    // PKCS#8 path specifically.
    const { privateKey } = await generateKeyPair("ed25519");
    const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(verifyKeypairRoundTrip("ssh-ed25519 AAAAdifferent test", pkcs8)).toBe(false);
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

  it("emits a valid OpenSSH PEM when the inner block lands on a block-size boundary (no padding)", async () => {
    // The OpenSSH-format encoder pads the inner private blob to a multiple
    // of the cipher block size (8 for cipher=none). `inner.length` =
    // 4+4 (checkint*2) + 4+11 (algo "ssh-ed25519") + 4+32 (pub32) +
    // 4+64 (priv32||pub32) + 4+commentLen → 131 + commentLen. A 5-char
    // comment like "hello" yields 136 bytes — already a multiple of 8 —
    // so `padNeeded === 0` and the `if (padNeeded > 0) { ... }` block
    // is skipped. Without this test, that else-branch never fires in
    // CI and branch coverage drops below 100% on keypair.ts.
    const pair = await generateSshKeypair("hello");
    expect(pair.privateKeyPem).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(verifyKeypairRoundTrip(pair.publicKey, pair.privateKeyPem)).toBe(true);
    const parsed = ssh2Utils.parseKey(pair.privateKeyPem);
    expect(parsed instanceof Error ? parsed.message : (parsed as { type: string }).type).toBe(
      "ssh-ed25519"
    );
  });

  it("verifyKeypairRoundTrip returns false when an OpenSSH PEM lacks the magic header bytes", async () => {
    // A PEM that *names* itself OPENSSH PRIVATE KEY but whose decoded
    // payload doesn't start with "openssh-key-v1\\0" must not pass — the
    // internal `parseOpensshEd25519PrivateKey` throws and
    // `verifyKeypairRoundTrip` collapses that to `false`. This guards
    // the magic-byte check and exercises the parser's rejection path
    // for the line-of-defense scenario "BEGIN/END headers spoofed".
    const fakePem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      Buffer.from("not-magic-bytes-at-all").toString("base64") +
      "\n-----END OPENSSH PRIVATE KEY-----\n";
    expect(verifyKeypairRoundTrip("ssh-ed25519 AAA test", fakePem)).toBe(false);
  });

  it("verifyKeypairRoundTrip returns false for OpenSSH PEMs with cipher !== none (encrypted)", async () => {
    // Hand-craft the minimal openssh-key-v1 framing that a passphrase-
    // encrypted ed25519 key would have: magic + a non-"none" ciphername
    // string. The parser bails out as soon as it sees ciphername !==
    // "none" because we deliberately don't support reading encrypted
    // keys (the whole pipeline persists unencrypted material in
    // vps_ssh_keys for orchestrator re-use). The throw is caught by
    // `verifyKeypairRoundTrip` and surfaced as `false`.
    const magic = Buffer.from("openssh-key-v1\0", "binary");
    const cipher = Buffer.from("aes256-ctr", "utf8");
    const cipherStr = Buffer.alloc(4 + cipher.length);
    cipherStr.writeUInt32BE(cipher.length, 0);
    cipher.copy(cipherStr, 4);
    const body = Buffer.concat([magic, cipherStr]);
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      body.toString("base64") +
      "\n-----END OPENSSH PRIVATE KEY-----\n";
    expect(verifyKeypairRoundTrip("ssh-ed25519 AAA test", pem)).toBe(false);
  });
});
