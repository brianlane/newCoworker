/**
 * Unit-test environment guard.
 *
 * The repo's routine ops workflow is `set -a; source .env; set +a`, which
 * exports PRODUCTION credentials into the shell. Any `npm test` run from
 * such a shell would hand those live secrets to code under test — which is
 * exactly how the suite once sent real Resend verification emails to the
 * Stripe-fixture address paid@example.com on every run.
 *
 * CI runs the unit suite with none of these variables set, so the suite is
 * env-independent by contract: tests that need a key fake one in their own
 * `beforeEach`. Deleting the live values here makes a local run behave like
 * CI and guarantees no unit test can ever reach a real external service
 * with real credentials, regardless of the invoking shell.
 *
 * Scope: this file is registered via `setupFiles` in vitest.config.ts ONLY.
 * The integration and live-smoke configs (vitest.integration*.config.ts,
 * vitest.gemini-live.config.ts) intentionally keep their environment — they
 * exist to talk to real services.
 */

const LIVE_CREDENTIAL_ENV_VARS = [
  // Email (Resend)
  "RESEND_API_KEY",
  "EMAIL_INBOUND_SECRET",
  "EMAIL_VERIFICATION_TOKEN_SECRET",
  // Stripe
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  // Supabase
  "SUPABASE_SERVICE_ROLE_KEY",
  // Telnyx
  "TELNYX_API_KEY",
  "TELNYX_PUBLIC_KEY",
  // Google / Gemini
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  // VPS providers
  "HOSTINGER_API_TOKEN",
  "OVH_APP_KEY",
  "OVH_APP_SECRET",
  "OVH_CONSUMER_KEY",
  // Cloudflare
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_TUNNEL_TOKEN",
  // Rowboat / platform-internal bearers
  "ROWBOAT_GATEWAY_TOKEN",
  "ROWBOAT_VPS_CHAT_BEARER",
  "INTERNAL_CRON_SECRET",
  "NOTIFICATIONS_WEBHOOK_TOKEN",
  "PROVISIONING_PROGRESS_TOKEN",
  "AIFLOW_RENDER_TOKEN",
  "STREAM_URL_SIGNING_SECRET",
  "INTEGRATIONS_ENCRYPTION_KEY",
  // Workspace OAuth / third-party apps
  "NANGO_SECRET_KEY",
  "MICROSOFT_CLIENT_SECRET",
  "SLACK_CLIENT_SECRET",
  // Admin
  "ADMIN_PASSWORD"
] as const;

for (const name of LIVE_CREDENTIAL_ENV_VARS) {
  delete process.env[name];
}
