import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Reconcile `businesses.owner_email` with a confirmed account-email change.
 *
 * Businesses are keyed by `owner_email` (there is no stable owner_user_id), so a
 * Supabase auth-email change must be mirrored onto the business or the owner
 * loses access to it. The change is initiated by `/api/account/email`, which
 * records a `pending_email_changes` row {user_id, business_id, new_email} and
 * asks Supabase to email a confirmation link.
 *
 * We CANNOT rely on a single confirmation hook: Supabase may finalize the new
 * email when the link is opened on another device/browser (where the PKCE code
 * exchange in `/api/auth/callback` fails), and a normal password sign-in never
 * touches the callback at all. So this reconciler is idempotent and is invoked
 * from BOTH the auth callback (fast path) and the dashboard layout (covers every
 * authenticated render, regardless of how the user got there).
 *
 * It only acts once the live auth email actually equals the pending `new_email`,
 * and it deletes the pending row ONLY after the business update succeeds — a
 * failed update keeps the row so a later render can retry rather than stranding
 * the owner on a stale email.
 */
export async function reconcilePendingEmailChange(
  userId: string | null | undefined,
  email: string | null | undefined,
  client?: SupabaseClient
): Promise<void> {
  if (!userId || !email) return;

  const db = client ?? (await createSupabaseServiceClient());
  const { data: pendingRow, error: selectError } = await db
    .from("pending_email_changes")
    .select("user_id, old_email, new_email")
    .eq("user_id", userId)
    .maybeSingle();
  if (selectError || !pendingRow) return;

  const pending = pendingRow as { user_id: string; old_email: string; new_email: string };
  if (email.toLowerCase() !== pending.new_email.toLowerCase()) return;

  // Move EVERY business that was keyed to the old email — an owner can have more
  // than one `businesses` row under the same `owner_email`, and all of them must
  // follow the login or the extras become inaccessible (and reconciliation never
  // runs again once the pending row is gone). Match on the pre-change `old_email`
  // (businesses still hold it at this point) and write the authoritative Supabase
  // email (exact case) so requireOwner's `owner_email = auth.email()` keeps
  // matching.
  const { error: updateError } = await db
    .from("businesses")
    .update({ owner_email: email })
    .eq("owner_email", pending.old_email);
  if (updateError) return;

  await db.from("pending_email_changes").delete().eq("user_id", pending.user_id);
}
