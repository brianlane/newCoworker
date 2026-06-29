/**
 * Pure compiler: turn an authored `voice` AiFlow definition into the runtime
 * decision the Telnyx voice webhook (telnyx-voice-inbound) executes.
 *
 * Voice flows are the AiFlows-native replacement for the legacy
 * `voice_handoff_chains` / `voice_caller_transfer_rules` tables: the owner
 * authors call routing as a flow (so it's visible + CRUD-able alongside their
 * other AiFlows), and this compiler maps its steps onto the SAME real-time
 * state machine the legacy rows drove. It produces either:
 *   - a single blind warm transfer (one `voice_transfer` step → the old
 *     per-caller transfer rule), or
 *   - a warm-handoff chain (`ring_handoff` steps + an optional trailing
 *     `voice_ai_intake` → the old handoff chain), reusing buildHandoffContext.
 *
 * Pure + dependency-free (only imports the pure handoff helpers) so it can be
 * unit-tested under vitest AND imported by the Deno edge function.
 */
import { buildHandoffContext, type HandoffContext } from "../voice_handoff.ts";
import type { AiFlowDefinition, FlowStep } from "./types.ts";

export type VoicePlan =
  | { kind: "transfer"; toE164: string; whisper: string }
  | { kind: "handoff"; context: HandoffContext };

/**
 * Compile a voice flow definition into a {@link VoicePlan}, or null when the
 * definition isn't a usable voice flow (wrong channel, no transfer target, or a
 * handoff chain with no ringable human). `toE164` is the business number that
 * was dialed — stored on the resulting handoff context for the session row.
 *
 * Defensive against partially-shaped definitions (the webhook reads raw JSONB):
 * it filters to the recognized voice steps and lets buildHandoffContext drop any
 * step missing a `to_e164`, so a malformed flow falls through (null) to the
 * legacy lookup rather than stranding the caller.
 */
export function compileVoiceFlow(
  def: AiFlowDefinition,
  toE164: string
): VoicePlan | null {
  if (!def || def.trigger?.channel !== "voice") return null;
  const steps: FlowStep[] = Array.isArray(def.steps) ? def.steps : [];

  // Blind transfer wins if present: connect the caller straight to the number.
  for (const s of steps) {
    if (s.type === "voice_transfer") {
      const to = typeof s.toE164 === "string" ? s.toE164.trim() : "";
      if (!to) return null;
      return { kind: "transfer", toE164: to, whisper: (s.whisper ?? "").trim() };
    }
  }

  // Otherwise a warm-handoff chain: ring_handoff steps (in order) + optional AI.
  const rawSteps = steps
    .filter((s): s is Extract<FlowStep, { type: "ring_handoff" }> => s.type === "ring_handoff")
    .map((s) => ({ to_e164: s.toE164, ring_secs: s.ringSeconds }));

  let aiTakeover: Record<string, unknown> | null = null;
  const intake = steps.find(
    (s): s is Extract<FlowStep, { type: "voice_ai_intake" }> => s.type === "voice_ai_intake"
  );
  if (intake && typeof intake.notifyE164 === "string" && intake.notifyE164.trim()) {
    aiTakeover = {
      notify_e164: intake.notifyE164.trim(),
      ...(intake.persona ? { persona: intake.persona } : {}),
      ...(Array.isArray(intake.captureFields) ? { capture_fields: intake.captureFields } : {})
    };
  }

  const context = buildHandoffContext({ toE164, steps: rawSteps, aiTakeover });
  if (context.steps.length === 0) return null;
  return { kind: "handoff", context };
}
