import { describe, it, expect, afterEach } from "vitest";
import {
  applyAuthenticatorPreference,
  supportsWebAuthnJson
} from "@/lib/auth/passkey-registration";

const SERVER_OPTIONS: PublicKeyCredentialCreationOptionsJSON = {
  challenge: "Y2hhbGxlbmdl",
  rp: { id: "newcoworker.com", name: "New Coworker" },
  user: { id: "dXNlci1pZA", name: "owner@business.com", displayName: "owner@business.com" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  attestation: "none",
  authenticatorSelection: { residentKey: "required", userVerification: "preferred" }
};

describe("supportsWebAuthnJson", () => {
  const original = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = original;
    }
  });

  it("is false on the server, where there is no window", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(supportsWebAuthnJson()).toBe(false);
  });

  it("is false without WebAuthn at all", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(supportsWebAuthnJson()).toBe(false);
  });

  it("is false on WebAuthn Level 1 browsers with no JSON helper", () => {
    (globalThis as { window?: unknown }).window = { PublicKeyCredential: function () {} };
    expect(supportsWebAuthnJson()).toBe(false);
  });

  it("is false when the credential cannot serialize itself back to JSON", () => {
    const PublicKeyCredential = function () {};
    (PublicKeyCredential as unknown as Record<string, unknown>).parseCreationOptionsFromJSON =
      () => ({});
    (globalThis as { window?: unknown }).window = { PublicKeyCredential };
    expect(supportsWebAuthnJson()).toBe(false);
  });

  it("is true once both JSON helpers exist", () => {
    const PublicKeyCredential = function () {};
    (PublicKeyCredential as unknown as Record<string, unknown>).parseCreationOptionsFromJSON =
      () => ({});
    PublicKeyCredential.prototype.toJSON = () => ({});
    (globalThis as { window?: unknown }).window = { PublicKeyCredential };
    expect(supportsWebAuthnJson()).toBe(true);
  });
});

describe("applyAuthenticatorPreference", () => {
  it("passes the server's options through untouched for 'any'", () => {
    expect(applyAuthenticatorPreference(SERVER_OPTIONS, "any")).toBe(SERVER_OPTIONS);
  });

  it("asks for the client device for 'this-device'", () => {
    const result = applyAuthenticatorPreference(SERVER_OPTIONS, "this-device");
    expect(result.hints).toEqual(["client-device"]);
    expect(result.authenticatorSelection?.authenticatorAttachment).toBe("platform");
  });

  it("keeps every server-owned field that verification depends on", () => {
    const result = applyAuthenticatorPreference(SERVER_OPTIONS, "this-device");
    expect(result.challenge).toBe(SERVER_OPTIONS.challenge);
    expect(result.rp).toEqual(SERVER_OPTIONS.rp);
    expect(result.user).toEqual(SERVER_OPTIONS.user);
    expect(result.pubKeyCredParams).toEqual(SERVER_OPTIONS.pubKeyCredParams);
    expect(result.attestation).toBe("none");
    // Discoverability is what makes usernameless sign-in work, so the
    // preference must never downgrade it.
    expect(result.authenticatorSelection?.residentKey).toBe("required");
    expect(result.authenticatorSelection?.userVerification).toBe("preferred");
  });

  it("does not mutate the options it was given", () => {
    const input: PublicKeyCredentialCreationOptionsJSON = {
      ...SERVER_OPTIONS,
      authenticatorSelection: { ...SERVER_OPTIONS.authenticatorSelection }
    };
    applyAuthenticatorPreference(input, "this-device");
    expect(input.hints).toBeUndefined();
    expect(input.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
  });

  it("works when the server sends no authenticatorSelection at all", () => {
    const { authenticatorSelection: _omitted, ...withoutSelection } = SERVER_OPTIONS;
    const result = applyAuthenticatorPreference(withoutSelection, "this-device");
    expect(result.authenticatorSelection).toEqual({ authenticatorAttachment: "platform" });
  });
});
