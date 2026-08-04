import { describe, expect, it, vi } from "vitest";
import {
  changeAccountPassword,
  WRONG_CURRENT_PASSWORD_MESSAGE,
  type PasswordChangeAuth
} from "@/lib/account/password-change";

/**
 * The Supabase project has "secure password change" on, so GoTrue rejects any
 * password update that does not carry the current password:
 *
 *   400 {"error_code":"current_password_required",
 *        "msg":"Current password required when setting new password."}
 *
 * Reproduced against the live project on a throwaway user: re-authenticating
 * first is NOT enough, the field has to travel with the update itself. That is
 * what the Zapier app reviewer hit, and it blocked every customer too.
 */
function makeAuth(
  overrides: {
    reauthError?: { message: string } | null;
    updateError?: { message: string } | null;
    /** Mimic GoTrue: reject the update unless current_password is present. */
    enforceCurrentPassword?: boolean;
  } = {}
): PasswordChangeAuth & {
  signInWithPassword: ReturnType<typeof vi.fn>;
  updateUser: ReturnType<typeof vi.fn>;
} {
  const signInWithPassword = vi
    .fn()
    .mockResolvedValue({ error: overrides.reauthError ?? null });
  const updateUser = vi.fn().mockImplementation(
    async (attributes: { password: string; current_password?: string }) => {
      if (overrides.enforceCurrentPassword && !attributes.current_password) {
        return {
          error: { message: "Current password required when setting new password." }
        };
      }
      return { error: overrides.updateError ?? null };
    }
  );
  return { signInWithPassword, updateUser };
}

const PARAMS = {
  email: "owner@example.com",
  currentPassword: "OldPassw0rd!x",
  newPassword: "NewPassw0rd!x"
};

describe("changeAccountPassword", () => {
  it("sends the current password with the update, not just to the re-auth call", async () => {
    const auth = makeAuth();

    await changeAccountPassword(auth, PARAMS);

    expect(auth.updateUser).toHaveBeenCalledWith({
      password: PARAMS.newPassword,
      current_password: PARAMS.currentPassword
    });
  });

  it("succeeds against an auth backend that enforces current_password", async () => {
    const auth = makeAuth({ enforceCurrentPassword: true });

    const result = await changeAccountPassword(auth, PARAMS);

    expect(result).toEqual({ ok: true });
  });

  it("re-authenticates with the current password before updating", async () => {
    const auth = makeAuth();

    await changeAccountPassword(auth, PARAMS);

    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: PARAMS.email,
      password: PARAMS.currentPassword
    });
  });

  it("reports a wrong current password without attempting the update", async () => {
    const auth = makeAuth({ reauthError: { message: "Invalid login credentials" } });

    const result = await changeAccountPassword(auth, PARAMS);

    expect(result).toEqual({ ok: false, message: WRONG_CURRENT_PASSWORD_MESSAGE });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("surfaces an update failure verbatim", async () => {
    const auth = makeAuth({ updateError: { message: "Password is too weak" } });

    const result = await changeAccountPassword(auth, PARAMS);

    expect(result).toEqual({ ok: false, message: "Password is too weak" });
  });
});
