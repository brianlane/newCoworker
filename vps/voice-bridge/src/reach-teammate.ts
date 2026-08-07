/**
 * The reach_teammate ladder: dial each teammate IN ORDER on a separate B leg
 * while the caller keeps talking to the assistant on the A leg, bridge the
 * first who answers, and report failure honestly when nobody does.
 *
 * The state machine and client-state format are LOCKSTEP COPIES of
 * supabase/functions/_shared/voice_reach.ts (the bridge cannot import Deno
 * modules); the webhook side (telnyx-voice-call-end's handleReachLeg) parses
 * exactly this client_state and stamps the outcome onto the A leg's session
 * `context.reach`, which `pollReachOutcome` here reads. Change one side and
 * you must change the other.
 *
 * Why polling the session, not webhooks: this VPS receives no Telnyx
 * webhooks, and the call-status endpoint reports only `is_alive`, which is
 * equally true of a phone that is merely ringing. The webhook edge function
 * is the one place that learns "they actually answered", and the session row
 * is the agreed meeting point.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const REACH_CS_PREFIX = "rt";

export type ReachTarget = { name: string; e164: string };

export type ReachLadderConfig = {
  targets: ReachTarget[];
  ringSeconds: number;
  preSmsBody: string;
};

/** `rt:<businessId>:<aLegCallControlId>:<attempt>` (see voice_reach.ts). */
export function encodeReachClientState(
  businessId: string,
  aLegCallControlId: string,
  attempt: number
): string {
  return [REACH_CS_PREFIX, businessId, aLegCallControlId, String(attempt)].join(":");
}

export const DEFAULT_REACH_RING_SECONDS = 20;
export const MIN_REACH_RING_SECONDS = 5;
export const MAX_REACH_RING_SECONDS = 45;

export function clampReachRingSeconds(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_REACH_RING_SECONDS;
  if (n < MIN_REACH_RING_SECONDS) return MIN_REACH_RING_SECONDS;
  if (n > MAX_REACH_RING_SECONDS) return MAX_REACH_RING_SECONDS;
  return n;
}

/** Parse the session-context block originate writes (context.reach_targets). */
export function parseReachLadderConfig(raw: unknown): ReachLadderConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawTargets = Array.isArray(r.targets) ? r.targets : [];
  const targets: ReachTarget[] = [];
  for (const rt of rawTargets) {
    const t = rt as Record<string, unknown> | null;
    const e164 = t && typeof t.e164 === "string" ? t.e164.trim() : "";
    if (!e164) continue;
    targets.push({ name: typeof t!.name === "string" ? t!.name.trim() : "", e164 });
  }
  if (targets.length === 0) return null;
  return {
    targets,
    ringSeconds: clampReachRingSeconds(r.ring_seconds),
    preSmsBody: typeof r.pre_sms_body === "string" ? r.pre_sms_body.trim() : ""
  };
}

/**
 * What the webhook stamped for this attempt, or null when nothing landed
 * yet. The stamp carries the attempt number so a slow prior attempt's late
 * event can never be read as the current one's answer.
 */
export async function readReachOutcome(
  supabase: SupabaseClient,
  aLegCallControlId: string,
  attempt: number
): Promise<{ status: "answered" | "no_answer"; bLeg: string } | null> {
  const { data, error } = await supabase
    .from("voice_handoff_sessions")
    .select("context")
    .eq("call_control_id", aLegCallControlId)
    .maybeSingle();
  if (error) return null;
  const reach = (
    (data as { context?: { reach?: Record<string, unknown> } } | null)?.context?.reach ?? null
  ) as Record<string, unknown> | null;
  if (!reach) return null;
  if (typeof reach.attempt !== "number" || reach.attempt !== attempt) return null;
  const status = reach.status === "answered" ? "answered" : reach.status === "no_answer" ? "no_answer" : null;
  if (!status) return null;
  return { status, bLeg: typeof reach.b_leg === "string" ? reach.b_leg : "" };
}

/**
 * Wait for this attempt's outcome: answered, rang out, or the ring window
 * elapsing with no webhook at all (network loss), which counts as no_answer
 * so the ladder always advances and the caller is never stranded listening
 * to the assistant stall.
 */
export async function pollReachOutcome(
  supabase: SupabaseClient,
  aLegCallControlId: string,
  attempt: number,
  ringSeconds: number,
  opts: { pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ status: "answered" | "no_answer"; bLeg: string }> {
  const pollMs = opts.pollMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // One extra poll interval of grace past the ring window: the webhook that
  // says "no answer" fires when Telnyx gives up at timeout_secs, and cutting
  // the poll at exactly that moment loses the race with our own dial timeout.
  const deadline = Date.now() + ringSeconds * 1000 + 2 * pollMs;
  while (Date.now() < deadline) {
    const outcome = await readReachOutcome(supabase, aLegCallControlId, attempt);
    if (outcome) return outcome;
    await sleep(pollMs);
  }
  return { status: "no_answer", bLeg: "" };
}
