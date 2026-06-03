import { after } from "next/server";
import { syncVaultToVpsAndLog } from "./sync-vault";

/**
 * Schedule the vault → VPS re-seed to run AFTER the HTTP response is sent.
 *
 * Why this exists (and why `void syncVaultToVpsAndLog(...)` was a bug):
 *   On Vercel, a bare promise kicked off before a route `return`s is frozen
 *   and torn down the moment the response flushes. The SSH re-seed
 *   (`syncVaultToVps`) takes ~5–15s (longer on a cold VPS), so the
 *   fire-and-forget promise was routinely killed mid-flight. The result: an
 *   owner's memory/config edit landed in Supabase (so the dashboard Memory
 *   panel showed it), but the per-tenant Rowboat agent's MongoDB
 *   `instructions` stayed frozen at the last successful sync — the agent kept
 *   answering from a stale prompt (e.g. "I don't have that phone number" even
 *   though it was just saved).
 *
 *   `after()` is Next.js's supported primitive for post-response work: Vercel
 *   keeps the invocation alive until the callback settles, bounded by the
 *   route's `maxDuration`. The response still returns immediately, so callers
 *   (including the chat-worker's short-timeout POST) are never blocked on the
 *   sync.
 *
 * `syncVaultToVpsAndLog` owns its own try/catch and never throws, so there's
 * nothing to catch here.
 */
export function scheduleVaultSync(businessId: string): void {
  after(() => syncVaultToVpsAndLog(businessId));
}
