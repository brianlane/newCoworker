/**
 * Per-business 10DLC campaign attach orchestration.
 *
 * Wraps the Telnyx 10DLC client + the dashboard status table so callers
 * (the provisioning orchestrator + the periodic retry worker) get one
 * idempotent entry point: "attach this business's DID to our shared
 * campaign, persist the outcome, and tell me what happened".
 *
 * Outcome semantics:
 *   - `registered`        — POST /phoneNumberCampaign returned 200 (or 409,
 *                           which means the pairing already exists — same
 *                           net effect for the dashboard).
 *   - `pending`           — Skipped because (a) we don't have a campaign id
 *                           yet, (b) the campaign isn't ACTIVE, or (c) the
 *                           DID isn't reachable yet. Surface a user-friendly
 *                           reason; nothing fatal.
 *   - `rejected`          — Telnyx returned a hard error (4xx other than
 *                           404/409). Captured verbatim in last_error so we
 *                           can show it in the banner / debug from the DB.
 *   - `error`             — Transient infrastructure failure (5xx, timeout,
 *                           DB write blew up). NOT persisted to status —
 *                           the row stays in its current state and the
 *                           caller should retry later.
 *
 * Why "skip" instead of "throw" when the campaign isn't active: provisioning
 * runs synchronously during onboarding. Forcing the orchestrator to wait
 * 24+ hours for carrier vetting would block sign-up. Instead we record
 * `pending` with a clear reason and let the cron worker retry.
 */

import {
  TendlcClient,
  TendlcApiError,
  type TendlcCampaign
} from "@/lib/telnyx/tendlc";
import { setBusinessMessagingCampaignStatus } from "@/lib/db/telnyx-routes";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type TendlcConfig = {
  apiKey: string;
  brandId: string;
  campaignId: string;
};

export class MissingTendlcConfigError extends Error {
  public readonly missing: ReadonlyArray<keyof TendlcConfig>;
  constructor(missing: Array<keyof TendlcConfig>) {
    super(
      `10DLC config missing: ${missing.join(", ")}. SMS will be queued in 'pending' until populated.`
    );
    this.name = "MissingTendlcConfigError";
    this.missing = missing;
  }
}

/**
 * Read the platform 10DLC config from env. Returns `null` when 10DLC isn't
 * configured yet (initial bootstrap) so callers can fall back to "queue as
 * pending". Throws `MissingTendlcConfigError` when SOME but not all values
 * are set — that's almost always a misconfiguration we want loudly visible.
 *
 * Why the cold-start gate ignores TELNYX_API_KEY:
 *   `TELNYX_API_KEY` is shared platform infrastructure — it's set in every
 *   environment because voice routing, admin tools, and outbound SMS all
 *   need it. If we required it to be missing for "cold start", every prod
 *   tenant would hit the partial-config branch (apiKey set, brandId/
 *   campaignId not yet) and throw — which the orchestrator then catches
 *   with NO DB write, leaving `last_attempt_at` stale and the dashboard
 *   banner uninformative. Gate cold-start on the 10DLC-specific keys only;
 *   they're set together (or not at all) by the rollout that adds 10DLC.
 */
export function readTendlcConfig(
  env: Record<string, string | undefined> = process.env
): TendlcConfig | null {
  const apiKey = env.TELNYX_API_KEY?.trim();
  const brandId = env.TELNYX_10DLC_BRAND_ID?.trim();
  const campaignId = env.TELNYX_10DLC_CAMPAIGN_ID?.trim();
  // Cold start: 10DLC not yet rolled out for this deployment. Caller
  // treats as "no 10DLC", records pending, and the retry worker picks
  // it up once the env is populated.
  if (!brandId && !campaignId) return null;
  const missing: Array<keyof TendlcConfig> = [];
  if (!apiKey) missing.push("apiKey");
  if (!brandId) missing.push("brandId");
  if (!campaignId) missing.push("campaignId");
  if (missing.length > 0) {
    throw new MissingTendlcConfigError(missing);
  }
  return {
    apiKey: apiKey as string,
    brandId: brandId as string,
    campaignId: campaignId as string
  };
}

export type AttachOutcome =
  | { kind: "registered"; campaignId: string }
  | { kind: "pending"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "error"; reason: string };

export type AttachInput = {
  businessId: string;
  toE164: string;
  /** Inject for tests. Defaults to a real TendlcClient + live env config. */
  client?: TendlcClient;
  /** Inject for tests. */
  config?: TendlcConfig | null;
  /** Skip the live `getCampaign` poll (for tests / when the orchestrator
   * already knows the campaign is ACTIVE). */
  skipCampaignStatusCheck?: boolean;
  /** Inject the supabase client (test seam — DB writes are mocked). */
  dbClient?: SupabaseClient;
};

/**
 * Idempotent: safe to re-run. Persists the outcome to
 * `business_telnyx_settings.telnyx_messaging_campaign_status` so the
 * dashboard banner and the retry worker share one source of truth.
 */
export async function attachBusinessDidToCampaign(
  input: AttachInput
): Promise<AttachOutcome> {
  const config = input.config ?? readTendlcConfig();
  if (!config) {
    return persistAndReturn(input.businessId, input.dbClient, {
      kind: "pending",
      reason: "10dlc_not_configured"
    });
  }

  const client =
    input.client ??
    new TendlcClient({
      apiKey: config.apiKey,
      // 30s default is too tight when Telnyx is mid-vetting and the campaign
      // GET stalls on the carrier side. Keep enough headroom that one slow
      // poll doesn't cascade into a "registered → pending" flap.
      timeoutMs: 45_000
    });

  if (!input.skipCampaignStatusCheck) {
    let campaign: TendlcCampaign;
    try {
      campaign = await client.getCampaign(config.campaignId);
    } catch (err) {
      const reason = describeError(err);
      // Treat 4xx on getCampaign as a hard config issue (campaign id is
      // wrong / suspended / deleted). 5xx and network → transient error.
      const transient =
        !(err instanceof TendlcApiError) ||
        err.status >= 500 ||
        err.status === 0;
      return persistAndReturn(input.businessId, input.dbClient, {
        kind: transient ? "error" : "rejected",
        reason: `getCampaign_failed: ${reason}`
      });
    }
    if (campaign.status !== "ACTIVE") {
      // Carrier vetting still in progress — nothing for us to do.
      return persistAndReturn(input.businessId, input.dbClient, {
        kind: "pending",
        reason: `campaign_status:${campaign.status || "unknown"}`
      });
    }
  }

  try {
    await client.createPhoneNumberCampaign({
      phoneNumber: input.toE164,
      campaignId: config.campaignId
    });
  } catch (err) {
    if (err instanceof TendlcApiError) {
      if (err.conflict) {
        // Already attached — we're done. Telnyx's 409 means "this exact
        // pairing exists", not "different pairing exists" (which is 422).
        return persistAndReturn(input.businessId, input.dbClient, {
          kind: "registered",
          campaignId: config.campaignId
        });
      }
      if (isCampaignStillProcessing(err)) {
        return persistAndReturn(input.businessId, input.dbClient, {
          kind: "pending",
          reason: `attach_pending: ${describeError(err)}`
        });
      }
      if (err.status >= 400 && err.status < 500) {
        return persistAndReturn(input.businessId, input.dbClient, {
          kind: "rejected",
          reason: `attach_failed: ${describeError(err)}`
        });
      }
    }
    return persistAndReturn(input.businessId, input.dbClient, {
      kind: "error",
      reason: `attach_failed: ${describeError(err)}`
    });
  }

  return persistAndReturn(input.businessId, input.dbClient, {
    kind: "registered",
    campaignId: config.campaignId
  });
}

async function persistAndReturn(
  businessId: string,
  dbClient: SupabaseClient | undefined,
  outcome: AttachOutcome
): Promise<AttachOutcome> {
  // Transient infra errors don't update status — the row stays in its
  // current state so a re-run picks up where we left off.
  if (outcome.kind === "error") return outcome;

  await setBusinessMessagingCampaignStatus(
    {
      businessId,
      status: outcome.kind,
      campaignId:
        outcome.kind === "registered" ? outcome.campaignId : undefined,
      lastError:
        outcome.kind === "rejected" || outcome.kind === "pending"
          ? outcome.reason
          : null
    },
    dbClient
  );
  return outcome;
}

function describeError(err: unknown): string {
  if (err instanceof TendlcApiError) {
    return `telnyx_${err.status}: ${err.body.slice(0, 200)}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function isCampaignStillProcessing(err: TendlcApiError): boolean {
  if (err.status !== 400) return false;
  return (
    err.body.includes('"code": "10036"') ||
    err.body.includes('"code":"10036"') ||
    err.body.toLowerCase().includes("campaign") &&
      err.body.toLowerCase().includes("still pending")
  );
}
