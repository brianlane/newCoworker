import { beforeEach, describe, expect, it } from "vitest";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

describe("integrations/secrets", () => {
  beforeEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "integration-secret-for-tests";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("round-trips encrypted secrets", () => {
    const encrypted = encryptIntegrationSecret("refresh-token");
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toBe("refresh-token");
    expect(decryptIntegrationSecret(encrypted)).toBe("refresh-token");
  });

  it("passes legacy plaintext values through unchanged", () => {
    expect(decryptIntegrationSecret("legacy-plaintext-token")).toBe("legacy-plaintext-token");
  });

  it("returns null for nullish values", () => {
    expect(encryptIntegrationSecret(null)).toBeNull();
    expect(decryptIntegrationSecret(null)).toBeNull();
  });

  it("does not re-encrypt values already marked as encrypted", () => {
    const encrypted = encryptIntegrationSecret("refresh-token");
    expect(encryptIntegrationSecret(encrypted)).toBe(encrypted);
  });

  it("throws on malformed encrypted payloads", () => {
    expect(() => decryptIntegrationSecret("enc:v1:bad")).toThrow(
      "decryptIntegrationSecret: invalid payload"
    );
  });

  it("throws on encrypted payloads with missing required parts", () => {
    expect(() => decryptIntegrationSecret("enc:v1::tag:cipher")).toThrow(
      "decryptIntegrationSecret: invalid payload"
    );
  });

  it("throws when no integration encryption secret is configured", () => {
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => encryptIntegrationSecret("refresh-token")).toThrow(
      "INTEGRATIONS_ENCRYPTION_KEY is not configured"
    );
  });
});
