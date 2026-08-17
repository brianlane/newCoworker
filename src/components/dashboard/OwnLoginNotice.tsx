/**
 * "This card acts on YOUR OWN login, not the tenant's."
 *
 * The dashboard is a tenant-representing surface, and under admin view-as most
 * of it genuinely retargets: business-scoped writes follow the view-as pin, and
 * the user-scoped account APIs follow `resolveViewAsTargetUser`. A few cards
 * cannot follow, because they act on the caller's live browser session rather
 * than through an API we control:
 *
 *   * the password form (`changeAccountPassword` re-authenticates the session
 *     with `signInWithPassword`),
 *   * the passkeys card (`supabase.auth.passkey.*` enrolls the device holding
 *     the session),
 *   * sign-out-everywhere (revokes the caller's cookies).
 *
 * Retargeting those is not a matter of passing a different id: there is no
 * session-scoped API that can act on someone else's browser. So the honest fix
 * is to say which account the card is really editing. An unlabeled
 * session-scoped form on a page that otherwise shows a customer's identity is
 * how an operator rotates their own credentials by accident.
 *
 * One component so the three read identically and the styling is defined once;
 * the copy stays per-card because "you are about to change your own password"
 * and "you are about to remove your own passkey" are different warnings.
 */
export function OwnLoginNotice({ show, children }: { show: boolean; children: string }) {
  if (!show) return null;
  return (
    <p className="mb-3 rounded-lg border border-spark-orange/30 bg-spark-orange/10 px-3 py-2 text-xs text-parchment/80">
      {children}
    </p>
  );
}
