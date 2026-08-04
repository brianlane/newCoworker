/**
 * Settings → Account: change the signed-in user's password.
 *
 * Extracted from AccountCredentialsForms so the contract is unit-testable: the
 * bug this module exists to prevent was invisible from the component, because
 * the failing call is made by the Supabase SDK, not by us.
 */

export type PasswordChangeAuth = {
  signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<{ error: { message: string } | null }>;
  updateUser(attributes: {
    password: string;
    current_password?: string;
  }): Promise<{ error: { message: string } | null }>;
};

export type PasswordChangeResult = { ok: true } | { ok: false; message: string };

export const WRONG_CURRENT_PASSWORD_MESSAGE = "Current password is incorrect.";

export async function changeAccountPassword(
  auth: PasswordChangeAuth,
  params: { email: string; currentPassword: string; newPassword: string }
): Promise<PasswordChangeResult> {
  // Re-authenticate with the current password before allowing a change, so a
  // hijacked-but-logged-in session can't silently rotate the password.
  const { error: reauthError } = await auth.signInWithPassword({
    email: params.email,
    password: params.currentPassword
  });
  if (reauthError) {
    return { ok: false, message: WRONG_CURRENT_PASSWORD_MESSAGE };
  }

  // `current_password` must travel WITH the update. The project has Supabase's
  // secure password change enabled, and GoTrue answers 400
  // `current_password_required` ("Current password required when setting new
  // password.") when it is missing, no matter how fresh the session above is.
  const { error: updateError } = await auth.updateUser({
    password: params.newPassword,
    current_password: params.currentPassword
  });
  if (updateError) {
    return { ok: false, message: updateError.message };
  }
  return { ok: true };
}
