/**
 * Sign-in account gate: an OAuth provider must never be a back door into
 * account CREATION.
 *
 * The bug this closes: "Log in with Google" on /login called
 * `signInWithOAuth`, and Supabase Auth happily MINTS a brand-new `auth.users`
 * row for any Google address it has never seen. The person lands on a
 * signed-in dashboard shell with no business behind it, gets asked to accept
 * the Terms, and shows up in the Supabase user list as if they were a
 * customer. Four such rows existed in production before this gate (two of
 * them strangers who had never bought anything).
 *
 * Every FIRST-PARTY way to get an account creates the business row first (the
 * paid flow mints the auth user in /api/onboard/set-password only after
 * Stripe confirms the checkout for a `businessId`) or creates an `email`
 * identity (the /signup form's `signUp`). So the discriminator is simple:
 *
 *   an account is legitimate if its sign-in identities include a first-party
 *   provider (email/phone), OR the address is already known to the product
 *   (owns a business, holds a team membership, or is the admin).
 *
 * An OAuth-only user matching none of those has no account, so the sign-in is
 * rejected. When that row was minted seconds ago by the very sign-in we are
 * rejecting, it is deleted too, otherwise we would still be accumulating the
 * empty accounts this module exists to prevent.
 *
 * Fail-open by design: this runs on the login path, so an unexpected shape or
 * a database hiccup must let a paying owner in, never lock them out. The
 * caller (/api/auth/callback) catches and allows on any throw.
 */

/** The `?error=` value /login renders as "this Google address has no account". */
export const NO_ACCOUNT_ERROR = "no_account";

/**
 * How recently the row must have been created for us to delete it. A sign-in
 * that mints a user is milliseconds old by the time we look, so this window
 * is generous; its whole job is to make sure we never hard-delete an account
 * that predates this request, however orphaned it looks. Older orphans are
 * signed out and refused, and cleaned up by hand.
 */
export const ORPHAN_DELETE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Providers that only exist because someone signed up THROUGH New Coworker.
 * Anything else (google, and any provider added later) can be minted by the
 * provider's own consent screen, which is exactly what we are gating.
 */
const FIRST_PARTY_PROVIDERS = new Set(["email", "phone"]);

type IdentityLike = { provider?: string | null };

/** The subset of a Supabase auth user this module reads. */
export type SignInUser = {
  id: string;
  email?: string | null;
  created_at?: string | null;
  identities?: IdentityLike[] | null;
  app_metadata?: { provider?: string | null; providers?: string[] | null } | null;
};

/** Minimal shape of the service-role client, so tests can hand in a stub. */
export type AccountLookupClient = {
  from: (table: string) => {
    select: (columns: string) => {
      ilike: (
        column: string,
        pattern: string
      ) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
      eq: (
        column: string,
        value: string
      ) => {
        neq: (
          column: string,
          value: string
        ) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
      };
    };
  };
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * `businesses.owner_email` is not lowercased by schema, so the match has to be
 * case-insensitive (`ilike`), and an address like `a_b@x.com` would otherwise
 * wildcard-match other rows. Same escaping as `listAccessibleBusinesses`.
 */
function likePattern(email: string): string {
  return email.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Which providers this login can authenticate with. Prefers `identities`
 * (authoritative, one row per linked provider) and falls back to
 * `app_metadata`, which Supabase always populates, so a response shape that
 * omits identities still yields a usable answer.
 */
export function signInProviders(user: SignInUser): string[] {
  const fromIdentities = (user.identities ?? []).map((i) => normalize(i.provider)).filter(Boolean);
  if (fromIdentities.length > 0) return fromIdentities;
  const meta = user.app_metadata ?? null;
  const listed = meta?.providers ?? (meta?.provider ? [meta.provider] : []);
  return listed.map(normalize).filter(Boolean);
}

/**
 * True when every way this login can authenticate came from an external
 * provider, i.e. nobody ever set a password or confirmed an email here.
 * Unknown provider list (empty) reads as false: fail open.
 */
export function isOAuthOnlySignIn(user: SignInUser): boolean {
  const providers = signInProviders(user);
  return providers.length > 0 && providers.every((p) => !FIRST_PARTY_PROVIDERS.has(p));
}

/** True when the auth row was created inside {@link ORPHAN_DELETE_WINDOW_MS}. */
export function isFreshlyMintedUser(user: SignInUser, nowMs: number): boolean {
  const createdMs = Date.parse(user.created_at ?? "");
  if (Number.isNaN(createdMs)) return false;
  const age = nowMs - createdMs;
  return age >= 0 && age <= ORPHAN_DELETE_WINDOW_MS;
}

/**
 * Does this address already have a New Coworker account? Owning a business,
 * holding a non-revoked team membership (an invite counts: the invite IS the
 * grant, and the dashboard binds it on first render), or being the admin all
 * qualify. Throws on a query error so the caller can fail open explicitly.
 */
export async function hasNewCoworkerAccount(
  email: string | null | undefined,
  db: AccountLookupClient
): Promise<boolean> {
  const normalized = normalize(email);
  if (!normalized) return false;

  const adminEmail = normalize(process.env.ADMIN_EMAIL);
  if (adminEmail.length > 0 && adminEmail === normalized) return true;

  const owned = await db
    .from("businesses")
    .select("id")
    .ilike("owner_email", likePattern(normalized))
    .limit(1);
  if (owned.error) throw new Error(`hasNewCoworkerAccount: ${owned.error.message}`);
  if ((owned.data ?? []).length > 0) return true;

  // `business_members.email` is lowercased by a schema CHECK, so equality is
  // an index lookup. Revoked rows are a removed teammate, not an account.
  const member = await db
    .from("business_members")
    .select("id")
    .eq("email", normalized)
    .neq("status", "revoked")
    .limit(1);
  if (member.error) throw new Error(`hasNewCoworkerAccount: ${member.error.message}`);
  return (member.data ?? []).length > 0;
}

export type SignInDecision =
  /** Nothing to do: a first-party login, or an OAuth login with an account. */
  | { allowed: true }
  /**
   * Refuse the sign-in. `deleteUserId` is the auth row to remove (set only
   * when this request minted it); null means sign out and leave the row for
   * a human to clean up.
   */
  | { allowed: false; deleteUserId: string | null };

/**
 * The whole gate: decide what to do with the session that just came back
 * through /api/auth/callback.
 */
export async function evaluateSignIn(
  user: SignInUser,
  db: AccountLookupClient,
  nowMs: number = Date.now()
): Promise<SignInDecision> {
  if (!isOAuthOnlySignIn(user)) return { allowed: true };
  if (await hasNewCoworkerAccount(user.email, db)) return { allowed: true };
  return { allowed: false, deleteUserId: isFreshlyMintedUser(user, nowMs) ? user.id : null };
}
