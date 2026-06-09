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
    .select("user_id, business_id, new_email")
    .eq("user_id", userId)
    .maybeSingle();
  if (selectError || !pendingRow) return;

  const pending = pendingRow as { user_id: string; business_id: string; new_email: string };
  if (email.toLowerCase() !== pending.new_email.toLowerCase()) return;

  // Store the authoritative Supabase email (exact case) so requireOwner's
  // `owner_email = auth.email()` comparison keeps matching.
  const { error: updateError } = await db
    .from("businesses")
    .update({ owner_email: email })
    .eq("id", pending.business_id);
  if (updateError) return;

  await db.from("pending_email_changes").delete().eq("user_id", pending.user_id);
}
