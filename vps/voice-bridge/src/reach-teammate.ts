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
  /** Telnyx connection the B legs dial through (stamped by originate). */
  connectionId: string;
  /** Caller id presented to the teammates: the tenant DID. */
  fromE164: string;
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
  const connectionId = typeof r.connection_id === "string" ? r.connection_id.trim() : "";
  const fromE164 = typeof r.from_e164 === "string" ? r.from_e164.trim() : "";
  // Originate stamps both alongside the targets; a ladder without them
  // cannot dial and registering the tool anyway would let the model promise
  // a transfer that can only fail.
  if (!connectionId || !fromE164) return null;
  return {
    targets,
    ringSeconds: clampReachRingSeconds(r.ring_seconds),
    preSmsBody: typeof r.pre_sms_body === "string" ? r.pre_sms_body.trim() : "",
    connectionId,
    fromE164
  };
}

/** The Telnyx surface the ladder needs, injectable so tests run without wire. */
export type ReachTelnyxDeps = {
  dial: (opts: {
    connectionId: string;
    to: string;
    from: string;
    timeoutSecs?: number;
    answeringMachineDetection?: string;
    clientState?: string;
  }) => Promise<{ ok: boolean; status: number; body?: string; callControlId?: string }>;
  bridge: (
    callControlId: string,
    opts: { otherCallControlId: string; parkAfterUnbridge?: boolean; commandId?: string }
  ) => Promise<{ ok: boolean; status: number; body?: string }>;
  hangup: (callControlId: string) => Promise<{ ok: boolean; status: number; body?: string }>;
  /** Best-effort pre-alert SMS; a failure must never block the dial. */
  sendPreSms?: (toE164: string, body: string) => Promise<void>;
};

export type ReachLadderResult =
  | { ok: true; connectedName: string; bLeg: string }
  | {
      ok: false;
      /**
       * Why the ladder failed, honestly:
       *   - "nobody_answered": at least one teammate's phone actually rang
       *     (or answered but could not be bridged) and nobody ended up
       *     connected. The caller may fairly be told nobody picked up.
       *   - "dials_refused": EVERY dial was refused before a phone rang
       *     (for example a Telnyx channel-limit 403 on each rung). Nobody
       *     was rung and no pre-alert was sent, so the model must not claim
       *     the team ignored the call (2026-08-16 incident review).
       */
      detail: "nobody_answered" | "dials_refused";
    };

/**
 * Walk the ladder: for each target in order, dial a B leg tagged with the
 * reach client_state, text the pre-alert once the dial actually went out,
 * wait for the webhook-stamped outcome on the A leg's session, and either
 * bridge (done) or hang the B leg up and try the next person.
 *
 * The B leg is ALWAYS hung up before the next target is dialed: without
 * that, a teammate whose voicemail answered late holds a zombie leg while
 * the next teammate's phone is already ringing, and the caller can end up
 * bridged to two places.
 *
 * The A leg's bridge command carries park_after_unbridge, so if the teammate
 * later drops, the caller is parked rather than hung up on.
 */
export async function runReachLadder(
  supabase: SupabaseClient,
  telnyx: ReachTelnyxDeps,
  args: {
    businessId: string;
    aLegCallControlId: string;
    config: ReachLadderConfig;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
    /**
     * Telemetry sink (the bridge's recordDiag). Reach B-leg dial refusals
     * were previously VISIBLE ONLY in VPS stdout: a Telnyx capacity 403 on
     * every rung read as "nobody answered" with no queryable trace anywhere
     * (2026-08-16 incident review). Optional so tests and older callers
     * need no stub; never awaited, never throws into the ladder.
     */
    telemetry?: (eventType: string, payload: Record<string, unknown>) => void;
    /**
     * Test seam: poll cadence + sleep, forwarded to pollReachOutcome AND to
     * awaitReachAmdClearance (which additionally honors capMs; the outcome
     * poll ignores it).
     */
    poll?: { pollMs?: number; sleep?: (ms: number) => Promise<void>; capMs?: number };
  }
): Promise<ReachLadderResult> {
  const { businessId, aLegCallControlId, config } = args;
  const log = args.log ?? (() => undefined);
  const telemetry = args.telemetry ?? (() => undefined);
  let anyDialSucceeded = false;
  for (let attempt = 0; attempt < config.targets.length; attempt += 1) {
    const target = config.targets[attempt]!;
    const dialRes = await telnyx.dial({
      connectionId: config.connectionId,
      to: target.e164,
      from: config.fromE164,
      // Telnyx enforces the ring window server-side too, so a lost webhook
      // still ends the attempt instead of ringing a phone forever.
      timeoutSecs: config.ringSeconds,
      // A teammate's voicemail ANSWERS the leg (a phone that is off reaches
      // it in a couple of seconds, inside any ring window), and an answer
      // alone would bridge the caller into the greeting. The verdict feeds
      // the clearance gate below.
      answeringMachineDetection: "premium",
      clientState: encodeReachClientState(businessId, aLegCallControlId, attempt)
    });
    if (!dialRes.ok || !dialRes.callControlId) {
      log("reach: dial refused, next target", {
        attempt,
        status: dialRes.status,
        body: dialRes.body?.slice(0, 120)
      });
      telemetry("voice_reach_dial_failed", {
        attempt,
        to: target.e164,
        http_status: dialRes.status ?? null,
        error_snippet: dialRes.body?.slice(0, 120) ?? null
      });
      continue;
    }
    anyDialSucceeded = true;
    // Pre-alert AFTER the dial went out, never before: a refused dial used
    // to leave the teammate hyped for a phone that never rings (2026-08-16
    // incident review). SMS delivery beats a 20s ring window comfortably.
    if (config.preSmsBody && telnyx.sendPreSms) {
      try {
        await telnyx.sendPreSms(target.e164, config.preSmsBody);
      } catch {
        // Best-effort by contract.
      }
    }
    const outcome = await pollReachOutcome(
      supabase,
      aLegCallControlId,
      attempt,
      config.ringSeconds,
      args.poll ?? {}
    );
    if (outcome.status === "answered") {
      const bLeg = outcome.bLeg || dialRes.callControlId;
      // An answer is not yet a person. A phone that is off reaches carrier
      // voicemail in a couple of seconds, inside any ring window, and the
      // voicemail ANSWERS the leg, bridging on the answer alone put the
      // caller inside a teammate's voicemail greeting. Hold the bridge until
      // AMD clears the leg: a human verdict bridges as soon as it lands
      // (typically inside a second or two), a machine verdict skips the rung
      // silently, and the cap fails open to bridging so a missing or late
      // verdict can never strand a live teammate holding a silent line.
      const clearance = await awaitReachAmdClearance(
        supabase,
        aLegCallControlId,
        attempt,
        args.poll ?? {}
      );
      if (clearance === "machine") {
        log("reach: voicemail answered, next target", { attempt });
        telemetry("voice_reach_vm_skipped", { attempt, to: target.e164 });
        // The webhook side usually hung the leg up with the verdict; this is
        // the belt for a hangup that failed, and a double hangup is a no-op.
        await telnyx.hangup(bLeg);
        continue;
      }
      // Stamp "this attempt is being bridged" BEFORE issuing the bridge, so a
      // machine verdict landing AFTER the clearance cap failed open cannot
      // hang up a leg the caller is now connected to (the webhook checks this
      // marker before its machine hangup). A cut mid-conversation on a late,
      // possibly wrong verdict is the worse failure; a fail-open that really
      // was a voicemail costs the awkward moment the cap already priced in.
      // Best-effort: a failed stamp narrows nothing but this protection.
      try {
        await supabase.rpc("voice_session_context_merge", {
          p_call_control_id: aLegCallControlId,
          p_patch: { reach_bridged: { attempt } }
        });
      } catch {
        // The bridge proceeds regardless; only the late-verdict shield thins.
      }
      const bridgeRes = await telnyx.bridge(aLegCallControlId, {
        otherCallControlId: bLeg,
        parkAfterUnbridge: true,
        commandId: `reach-bridge-${aLegCallControlId}-${attempt}`
      });
      if (bridgeRes.ok) {
        return { ok: true, connectedName: target.name || "a teammate", bLeg };
      }
      // The teammate answered but the join failed: release them so they are
      // not left holding a silent line, then keep trying the ladder rather
      // than reporting a success the caller never experienced. The bridge
      // shield stamped above must not outlive the failed bridge, or a late
      // machine verdict for this attempt would skip its hangup on a leg that
      // was never joined, leaving cleanup to rest on the single hangup below.
      try {
        await supabase.rpc("voice_session_context_merge", {
          p_call_control_id: aLegCallControlId,
          p_patch: { reach_bridged: null }
        });
      } catch {
        // Best-effort: the hangup below still tears the leg down.
      }
      log("reach: bridge failed after answer", { attempt, status: bridgeRes.status });
      await telnyx.hangup(bLeg);
      continue;
    }
    // Rang out (or the window elapsed silently): tear the B leg down before
    // the next dial. A late voicemail answer on it after this point is
    // handled by record_reach_outcome's attempt precedence.
    await telnyx.hangup(dialRes.callControlId);
    log("reach: no answer, next target", { attempt });
  }
  const detail = anyDialSucceeded ? "nobody_answered" : "dials_refused";
  telemetry("voice_reach_exhausted", { targets: config.targets.length, detail });
  return { ok: false, detail };
}

/**
 * How long an ANSWERED reach leg may wait for an AMD verdict before the
 * ladder bridges anyway.
 *
 * Premium AMD classifies a live "Hello?" within a second or two, so a real
 * teammate is bridged about as fast as the verdict lands and only the rare
 * no-verdict case pays the full cap. Fail-open on purpose: a bridged
 * voicemail (the pre-AMD behavior) costs an awkward moment, while refusing
 * to bridge a person who actually picked up costs the caller a teammate.
 */
export const REACH_AMD_CLEAR_MS = Number(process.env.REACH_AMD_CLEAR_MS ?? 3000);

/**
 * The AMD verdict the webhook stamped for this attempt, or null while none
 * has landed. Attempt-checked like readReachOutcome, so a stale verdict from
 * a torn-down earlier leg can never gate the current one.
 */
export async function readReachAmd(
  supabase: SupabaseClient,
  aLegCallControlId: string,
  attempt: number
): Promise<"human" | "machine" | null> {
  const { data, error } = await supabase
    .from("voice_handoff_sessions")
    .select("context")
    .eq("call_control_id", aLegCallControlId)
    .maybeSingle();
  if (error) return null;
  const amd = (
    (data as { context?: { reach_amd?: Record<string, unknown> } } | null)?.context?.reach_amd ??
    null
  ) as Record<string, unknown> | null;
  if (!amd) return null;
  if (typeof amd.attempt !== "number" || amd.attempt !== attempt) return null;
  return amd.verdict === "human" ? "human" : amd.verdict === "machine" ? "machine" : null;
}

/**
 * Wait briefly for the AMD verdict on an ANSWERED leg. "human" and "timeout"
 * both mean bridge (fail open); "machine" means skip the rung silently. The
 * poll runs tighter than the ring poll (250ms vs 1s) because the whole budget
 * is a few seconds and a person is waiting on both sides of it.
 */
export async function awaitReachAmdClearance(
  supabase: SupabaseClient,
  aLegCallControlId: string,
  attempt: number,
  opts: { pollMs?: number; sleep?: (ms: number) => Promise<void>; capMs?: number } = {}
): Promise<"human" | "machine" | "timeout"> {
  const pollMs = opts.pollMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.capMs ?? REACH_AMD_CLEAR_MS);
  for (;;) {
    const verdict = await readReachAmd(supabase, aLegCallControlId, attempt);
    if (verdict) return verdict;
    if (Date.now() >= deadline) return "timeout";
    await sleep(pollMs);
  }
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
