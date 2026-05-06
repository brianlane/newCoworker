/**
 * Internal, cron-triggered endpoint that retries 10DLC (A2P SMS) campaign
 * attaches for DIDs whose status is `pending` or `rejected`.
 *
 * Why this exists:
 *   The orchestrator best-effort-attaches a brand-new DID to our shared
 *   campaign during onboarding. That call is fire-and-forget — when the
 *   campaign isn't yet ACTIVE (carrier vetting takes 1-2 business days) or
 *   the rollout hasn't populated `TELNYX_10DLC_*` env yet, the DID lands in
 *   `pending`. Without a retry path it would stay there forever and
 *   outbound SMS to US carriers would silently 10DLC-fail. This worker
 *   re-drives the attach until the row reaches a terminal state.
 *
 * Call chain:
 *   pg_cron → Edge fn `tendlc-attach-retry` → this route.
 *   Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Per-row behavior (idempotent):
 *   - `pending`  : try attach; if Telnyx says campaign is ACTIVE and the
 *                  pairing succeeds, the row flips to `registered`.
 *   - `rejected` : same retry, since "rejected" can be transient (campaign
 *                  briefly suspended, brand re-vetted). When the body is
 *                  the same we get the same outcome; when carriers have
 *                  moved on we get a fresh chance at success.
 *   - skipped    : rows whose `last_attempt_at` is newer than
 *                  `staleAfterSeconds` are excluded by the SQL filter so
 *                  we don't hammer Telnyx every minute on the same row.
 *
 * Errors per row are isolated — one Telnyx 5xx doesn't block the rest.
 *
 * Response: `{ ok: true, processed, registered, pending, rejected, errors }`
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { listBusinessesPendingTendlcAttach } from "@/lib/db/telnyx-routes";
import {
  attachBusinessDidToCampaign,
  MissingTendlcConfigError,
  readTendlcConfig
} from "@/lib/provisioning/tendlc-attach";

// Per-tick row ceiling. Telnyx /10dlc/phoneNumberCampaign is sequential
// (no batch endpoint); 25 attaches at ~0.5s each = ~12s, well under the
// Vercel maxDuration. Backlogs drain over multiple ticks, which is fine
// because every row is idempotent.
const DEFAULT_LIMIT = 25;

// Skip rows that we attempted within the last 5 minutes — a hot retry
// loop on a `rejected` row would melt the Telnyx rate limit without
// changing the outcome. Carrier vetting is slow; one minute of latency
// per attempt is nothing.
const DEFAULT_STALE_SECONDS = 300;

export const maxDuration = 60;
export const runtime = "nodejs";

type RetryError = {
  businessId: string;
  toE164: string;
  message: string;
};

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  // Cold-start short-circuit. If 10DLC isn't configured at all, there's
  // nothing to retry — readTendlcConfig returns null and we exit fast
  // instead of churning DB queries that will all land in `pending`.
  let configured = true;
  try {
    configured = readTendlcConfig() !== null;
  } catch (err) {
    if (err instanceof MissingTendlcConfigError) {
      logger.warn("tendlc-attach-retry: partial 10DLC config; aborting", {
        missing: err.missing
      });
      return successResponse({
        processed: 0,
        registered: 0,
        pending: 0,
        rejected: 0,
        errors: [],
        skipped: "partial_config"
      });
    }
    throw err;
  }
  if (!configured) {
    return successResponse({
      processed: 0,
      registered: 0,
      pending: 0,
      rejected: 0,
      errors: [],
      skipped: "10dlc_not_configured"
    });
  }

  const startedAt = Date.now();

  let candidates;
  try {
    candidates = await listBusinessesPendingTendlcAttach({
      limit: DEFAULT_LIMIT,
      staleAfterSeconds: DEFAULT_STALE_SECONDS
    });
  } catch (err) {
    logger.error("tendlc-attach-retry: list query failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse(
      "INTERNAL_SERVER_ERROR",
      "Failed to list 10DLC retry candidates",
      500
    );
  }

  let registered = 0;
  let pending = 0;
  let rejected = 0;
  const errors: RetryError[] = [];

  for (const row of candidates) {
    try {
      const outcome = await attachBusinessDidToCampaign({
        businessId: row.business_id,
        toE164: row.to_e164
      });
      if (outcome.kind === "registered") registered += 1;
      else if (outcome.kind === "pending") pending += 1;
      else if (outcome.kind === "rejected") rejected += 1;
      else {
        // Transient infra error — count as a per-row error so it shows
        // up in the response, but DON'T persist as `rejected` (the
        // attach helper deliberately leaves the row's status alone for
        // the next tick).
        errors.push({
          businessId: row.business_id,
          toE164: row.to_e164,
          message: outcome.reason
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ businessId: row.business_id, toE164: row.to_e164, message });
      logger.error("tendlc-attach-retry: per-row failure; continuing", {
        businessId: row.business_id,
        toE164: row.to_e164,
        error: message
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info("tendlc-attach-retry: summary", {
    processed: candidates.length,
    registered,
    pending,
    rejected,
    errors: errors.length,
    durationMs
  });

  return successResponse({
    processed: candidates.length,
    registered,
    pending,
    rejected,
    errors,
    durationMs
  });
}
