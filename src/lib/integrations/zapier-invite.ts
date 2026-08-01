/**
 * The Zapier invite URL tenants must accept before "New Coworker" appears in
 * their Zap builder — the integration (app 243681) is not publicly listed in
 * Zapier's App Directory yet, so it is invisible to search without this.
 *
 * NOTE: invite links are PER PUSHED VERSION. After `zapier-platform push` of
 * a new version, run `npx zapier-platform users:links` and update this URL
 * (see zapier/README.md). Existing accepted users keep access.
 */
export const ZAPIER_INVITE_URL =
  "https://zapier.com/developer/public-invite/243681/506906/24d5aa1ef368f83387e80e0d130b5f22/";
