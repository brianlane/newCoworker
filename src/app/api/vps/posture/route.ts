import { z } from "zod";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { insertVpsPostureReport } from "@/lib/db/vps-posture";
import { parseHostMetrics } from "@/lib/vps/host-metrics";
import {
  EXPECTED_OLLAMA_ENV,
  describeOllamaEnvDrift,
  ollamaEnvDrift,
  tunedSizeForPin
} from "@/lib/vps/ollama-tuning";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  checks: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        ok: z.boolean(),
        detail: z.string().max(1000).optional()
      })
    )
    .min(1)
    .max(50),
  /**
   * Host CPU/memory aggregate, optional. Deliberately NOT a posture check:
   * the route ANDs every check into one `ok` and emits `vps_posture_drift`
   * on a failure, and a busy box is a capacity signal, not a security
   * finding. Optional because every box in the fleet runs a heartbeat that
   * predates this block until it is redeployed, and those reports must keep
   * being accepted unchanged. Passed through `parseHostMetrics`, which
   * rejects a partial object outright rather than storing a shape the
   * advisor would have to guess at.
   */
  metrics: z.unknown().optional(),
  /**
   * The Ollama process's live environment, for the bootstrap-drift check.
   * Optional: a box with no Ollama unit (kvm1) and a box running a heartbeat
   * that predates this block both omit it, and neither is a finding.
   */
  ollamaEnv: z.record(z.string(), z.string()).optional()
});

/**
 * Compare a box's LIVE Ollama environment against what bootstrap.sh would
 * write for its size, and return a posture check when they disagree.
 *
 * Why this exists: bootstrap.sh runs once, at provision. Editing it reaches
 * new boxes and nothing else, and every fleet rollout refreshes the repo and
 * the containers WITHOUT re-running it. So a setting could be correct in the
 * repo, green in CI, deployed to main, and absent from every live box, with
 * nothing anywhere reporting a problem. That is not hypothetical: the
 * KVM 2/KVM 4 `OLLAMA_CONTEXT_LENGTH` gap survived a month exactly that way,
 * and was only found by reading a box by hand.
 *
 * Returns null (no check, not a passing one) whenever the comparison cannot
 * be made, so "we could not tell" never renders as "it matches".
 */
function ollamaDriftCheck(
  reported: Record<string, string> | undefined,
  business: { tier: string; vps_size: string | null } | null
): { name: string; ok: boolean; detail: string } | null {
  if (!reported) return null;
  if (!business) return null;
  const size = tunedSizeForPin(
    business.vps_size,
    business.tier as "starter" | "standard" | "enterprise"
  );
  if (!size) return null; // kvm1 ships no Ollama to compare
  const drift = ollamaEnvDrift(EXPECTED_OLLAMA_ENV[size], reported);
  return drift.length === 0
    ? { name: "ollama_tuning_matches_bootstrap", ok: true, detail: `matches ${size} bootstrap tuning` }
    : {
        name: "ollama_tuning_matches_bootstrap",
        ok: false,
        detail: `${size} drift: ${describeOllamaEnvDrift(drift)}`.slice(0, 1000)
      };
}

/**
 * Box → platform posture report (heartbeat cron). Auth mirrors
 * /api/provisioning/progress: the bearer must be a gateway token bound to
 * this businessId (per-tenant token; the shared fallback still verifies for
 * not-yet-migrated boxes). Drift (any failed check) is persisted, logged,
 * and emitted as a `vps_posture_drift` telemetry event for alerting, it
 * never auto-pauses the tenant (BYOS customers have root; false positives
 * are possible).
 */
export async function POST(request: Request) {
  try {
    const parsed = bodySchema.parse(await request.json());

    const authorized = await verifyGatewayTokenForBusiness(request, parsed.businessId);
    if (!authorized) {
      return errorResponse("UNAUTHORIZED", "Invalid gateway token", 401);
    }

    // Business row for the drift comparison. A failed read must leave the
    // check out entirely rather than assume a size: guessing wrong would
    // either invent drift or, worse, quietly certify a box as matching.
    let business: { tier: string; vps_size: string | null } | null = null;
    try {
      const db = await createSupabaseServiceClient();
      const { data, error } = await db
        .from("businesses")
        .select("tier, vps_size")
        .eq("id", parsed.businessId)
        .maybeSingle();
      if (!error) business = data as { tier: string; vps_size: string | null } | null;
    } catch (err) {
      logger.warn("VPS posture business lookup failed", {
        businessId: parsed.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    const driftCheck = ollamaDriftCheck(parsed.ollamaEnv, business);
    const checks = driftCheck ? [...parsed.checks, driftCheck] : parsed.checks;

    const ok = checks.every((c) => c.ok);
    const metrics = parsed.metrics === undefined ? null : parseHostMetrics(parsed.metrics);
    if (parsed.metrics !== undefined && metrics === null) {
      // Say so rather than storing null silently: a box shipping a malformed
      // aggregate looks identical to a box too old to send one, and the
      // advisor treats a missing aggregate as "no data", so a quiet drop
      // would read as a healthy quiet box forever.
      logger.warn("VPS posture metrics rejected as malformed", {
        businessId: parsed.businessId
      });
    }
    const report = await insertVpsPostureReport({
      businessId: parsed.businessId,
      ok,
      checks,
      metrics
    });

    if (!ok) {
      const failed = checks.filter((c) => !c.ok);
      logger.warn("VPS posture drift reported", {
        businessId: parsed.businessId,
        failed: failed.map((c) => c.name)
      });
      // Best-effort telemetry: alerting reads telemetry_events; a transient
      // RPC failure must not reject the box's report (the row above is the
      // durable record).
      try {
        const db = await createSupabaseServiceClient();
        await db.rpc("telemetry_record", {
          p_event_type: "vps_posture_drift",
          p_payload: {
            business_id: parsed.businessId,
            report_id: report.id,
            failed: failed.map((c) => ({ name: c.name, detail: c.detail ?? "" }))
          }
        });
      } catch (err) {
        logger.warn("vps_posture_drift telemetry emit failed", {
          businessId: parsed.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return successResponse({ received: true, ok });
  } catch (err) {
    return handleRouteError(err);
  }
}
