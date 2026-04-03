import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const VERSION_PREFIX = "enc:v1";
const IV_BYTES = 12;

function getIntegrationsSecret(): string {
  const secret = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("INTEGRATIONS_ENCRYPTION_KEY is not configured");
  }
  return secret;
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptIntegrationSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith(`${VERSION_PREFIX}:`)) return value;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(getIntegrationsSecret()), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${VERSION_PREFIX}:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptIntegrationSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith(`${VERSION_PREFIX}:`)) return value;

  const parts = value.split(":");
  if (parts.length !== 5) {
    throw new Error("decryptIntegrationSecret: invalid payload");
  }

  const [, version, ivPart, tagPart, encryptedPart] = parts;
  if (version !== "v1" || !ivPart || !tagPart || !encryptedPart) {
    throw new Error("decryptIntegrationSecret: invalid payload");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(getIntegrationsSecret()),
    Buffer.from(ivPart, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}
