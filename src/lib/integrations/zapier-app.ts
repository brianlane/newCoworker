/**
 * Where a tenant goes to connect New Coworker inside Zapier.
 *
 * Zapier approved the integration (app 243681) into the public App Directory on
 * 2026-08-04, so tenants now find it by searching "New Coworker" in the Zap
 * editor and the invite link is no longer required to connect.
 *
 * This replaces ZAPIER_INVITE_URL, and retires a maintenance trap with it:
 * invite links were minted PER PUSHED VERSION, so every `zapier-platform push`
 * silently left this constant pointing at the previous version until somebody
 * caught it (see #1105). A directory URL is stable across versions.
 *
 * Tenants who accepted the old invite keep their connection. Nothing to migrate.
 *
 * The integration sits in Zapier's 90 day Beta: approved 2026-08-04, so the
 * window ends around 2026-11-02 (.github/workflows/zapier-beta-reminder.yml
 * opens an issue ahead of that date). Zapier can revert an app to Private
 * during Beta if it draws a lot of support requests; if that ever happens,
 * restore the invite constant from git history rather than hand-writing a
 * new one.
 */
export const ZAPIER_APP_URL = "https://zapier.com/apps/new-coworker/integrations";
