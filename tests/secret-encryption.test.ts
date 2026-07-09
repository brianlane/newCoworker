import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  SecretEncryptionError,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  secretsEqual
} from "@/lib/crypto/secret-encryption";

const KEY = randomBytes(32).toString("base64url");
const OTHER_KEY = randomBytes(32).toString("base64url");
const env = { SECRETS_ENCRYPTION_KEY: KEY };

describe("secret-encryption round trip", () => {
  it("encrypts to the versioned envelope and decrypts back", () => {
    const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
    const stored = encryptSecret(secret, env);
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(stored).toMatch(/^enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain("PRIVATE KEY");
    expect(decryptSecret(stored, env)).toBe(secret);
  });

  it("uses a fresh IV per encryption (no deterministic ciphertext)", () => {
    const a = encryptSecret("same-secret", env);
    const b = encryptSecret("same-secret", env);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, env)).toBe("same-secret");
    expect(decryptSecret(b, env)).toBe("same-secret");
  });

  it("encrypting an already-encrypted value is a no-op (no double wrap)", () => {
    const once = encryptSecret("secret", env);
    expect(encryptSecret(once, env)).toBe(once);
  });
});

describe("rollout compatibility (no key configured)", () => {
  it("writes pass through as plaintext and plaintext reads pass through", () => {
    expect(encryptSecret("plain", {})).toBe("plain");
    expect(decryptSecret("plain", {})).toBe("plain");
    expect(encryptSecret("plain", { SECRETS_ENCRYPTION_KEY: "  " })).toBe("plain");
  });

  it("fails closed reading an encrypted value without the key", () => {
    const stored = encryptSecret("secret", env);
    expect(() => decryptSecret(stored, {})).toThrow(SecretEncryptionError);
    expect(() => decryptSecret(stored, {})).toThrow(/SECRETS_ENCRYPTION_KEY is not set/);
  });
});

describe("failure modes", () => {
  it("rejects the wrong key and corrupted ciphertext", () => {
    const stored = encryptSecret("secret", env);
    expect(() => decryptSecret(stored, { SECRETS_ENCRYPTION_KEY: OTHER_KEY })).toThrow(
      /wrong SECRETS_ENCRYPTION_KEY or corrupted/
    );
    const tampered = stored.slice(0, -4) + (stored.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decryptSecret(tampered, env)).toThrow(SecretEncryptionError);
  });

  it("rejects malformed envelopes", () => {
    expect(() => decryptSecret("enc:v1:only-two:parts", env)).toThrow(/Malformed/);
    expect(() => decryptSecret("enc:v1:a:b:c:d", env)).toThrow(/Malformed/);
    // Bad IV length (valid base64url, wrong byte count).
    expect(() => decryptSecret("enc:v1:aGk:dGFn:Y3Q", env)).toThrow(/bad IV length/);
  });

  it("rejects keys that are not 32 bytes or not base64url", () => {
    const short = { SECRETS_ENCRYPTION_KEY: randomBytes(16).toString("base64url") };
    expect(() => encryptSecret("x", short)).toThrow(/must decode to 32 bytes/);
    // node's base64url decoder is lenient about most strings; a value with
    // characters entirely outside the alphabet decodes to few/zero bytes and
    // is caught by the length check at minimum.
    expect(() => encryptSecret("x", { SECRETS_ENCRYPTION_KEY: "!!!!" })).toThrow(
      SecretEncryptionError
    );
  });
});

describe("secretsEqual", () => {
  it("constant-time comparison semantics", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
  });
});
