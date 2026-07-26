/**
 * Steering WHERE a new passkey gets created.
 *
 * Supabase's server asks for a discoverable credential with user verification
 * preferred, but it deliberately states no `authenticatorAttachment` and no
 * `hints`. That neutrality means Chrome on macOS cannot tell that the owner
 * wants a passkey on the Mac in front of them, so it opens a chooser listing
 * "iCloud Keychain", "Chrome profile", a phone, and a USB security key, and
 * the owner has to go find the right one. Chrome only jumps straight to
 * Touch ID / iCloud Keychain when the site asks for a credential on the
 * client device.
 *
 * So we ask, and we let the owner say which they meant. `"this-device"` asks
 * for a platform authenticator, which sends Chrome straight to Touch ID and
 * iCloud Keychain (and Windows Hello elsewhere); `"any"` passes the server's
 * neutral options through untouched, which is what a phone or a hardware
 * security key needs. Neither is a fallback for the other, so the card offers
 * both rather than guessing.
 */
export type PasskeyAuthenticatorPreference = "this-device" | "any";

/**
 * Whether the browser exposes the WebAuthn Level 3 JSON helpers: both
 * `parseCreationOptionsFromJSON` to read the server's options and `toJSON` on
 * the credential to hand the result back. Both are needed, so both are
 * checked. Without them we cannot restate the server's options, and callers
 * fall back to the SDK's one-shot registration and the chooser it produces.
 */
export function supportsWebAuthnJson(): boolean {
  if (typeof window === "undefined") return false;
  const credential = window.PublicKeyCredential as
    | (typeof window.PublicKeyCredential & {
        parseCreationOptionsFromJSON?: unknown;
        prototype?: { toJSON?: unknown };
      })
    | undefined;
  return (
    typeof credential?.parseCreationOptionsFromJSON === "function" &&
    typeof credential?.prototype?.toJSON === "function"
  );
}

/**
 * Restates the server's creation options with the owner's chosen authenticator
 * preference. Everything else (challenge, relying party, resident-key
 * requirement) is passed through untouched: those are the server's call, and
 * changing them would break verification.
 */
export function applyAuthenticatorPreference(
  options: PublicKeyCredentialCreationOptionsJSON,
  preference: PasskeyAuthenticatorPreference
): PublicKeyCredentialCreationOptionsJSON {
  if (preference === "any") return options;

  return {
    ...options,
    hints: ["client-device"],
    authenticatorSelection: {
      ...options.authenticatorSelection,
      authenticatorAttachment: "platform"
    }
  };
}
