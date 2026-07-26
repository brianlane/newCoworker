/**
 * WebAuthn failure triage for the passkey sign-in and registration buttons.
 *
 * The single most common "failure" is not a failure at all: the owner opened
 * the system passkey sheet and dismissed it. The browser reports that the same
 * way it reports a timeout (`NotAllowedError`, surfaced by auth-js as
 * `ERROR_CEREMONY_ABORTED`), so treating it as an error would put a red
 * message on screen every time someone changes their mind.
 */
const CANCELLATION_CODES = new Set(["ERROR_CEREMONY_ABORTED"]);
const CANCELLATION_NAMES = new Set(["AbortError", "NotAllowedError"]);

function readStringProp(value: unknown, prop: string): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[prop];
  return typeof raw === "string" ? raw : null;
}

export function isPasskeyCeremonyCancellation(error: unknown): boolean {
  const code = readStringProp(error, "code");
  if (code && CANCELLATION_CODES.has(code)) return true;
  const name = readStringProp(error, "name");
  return name !== null && CANCELLATION_NAMES.has(name);
}

export function passkeyErrorMessage(error: unknown, fallback: string): string {
  const message = readStringProp(error, "message");
  return message && message.trim().length > 0 ? message : fallback;
}
