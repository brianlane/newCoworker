/**
 * Nudge the shared reply worker after a channel enqueues a job.
 *
 * Every channel's webhook needs this and none of them needs its own copy.
 * It is deliberately fire-and-forget and deliberately silent about
 * failures: the per-minute sweep is the retry net, so a kick that does not
 * land costs latency on one reply, never the reply itself. Missing
 * configuration defers to the sweep the same way.
 *
 * Callers should wrap this in `after()` so a slow internal hop cannot eat
 * into a provider's ack window. Telegram is patient; Slack wants 2xx in
 * three seconds.
 */

import { logger } from "@/lib/logger";

export async function kickCoworkerWorker(channel: string): Promise<void> {
  const secret = process.env.INTERNAL_CRON_SECRET?.trim();
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!secret || !base) return;
  try {
    await fetch(new URL("/api/internal/coworker-worker", base).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        // CSRF gate: src/proxy.ts allows server-to-server bearer POSTs only
        // when Origin matches NEXT_PUBLIC_APP_URL.
        Origin: base
      },
      body: "{}"
    });
  } catch (err) {
    logger.warn("coworker worker kick failed; sweep will retry", {
      channel,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
