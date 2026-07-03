/**
 * Dynamic contact reference resolution (see ContactRef in types.ts).
 *
 * A ContactRef points at a saved person — an employee (ai_flow_team_members)
 * or a contact (contacts) — whose phone number is read from the LIVE row at
 * run time instead of being hardcoded into the flow definition. That way a
 * rename / renumber / contact-merge after authoring is reflected automatically
 * (the surviving merge row keeps the canonical customer_e164).
 *
 * Consumers:
 *   - ai-flow-worker: send_sms.toRef + route_to_team.agentRef (per-step).
 *   - telnyx-voice-inbound / telnyx-voice-originate: resolveVoiceContactRefs
 *     rewrites a voice definition's *Ref fields into their *E164 siblings just
 *     before the pure compilers run (resolve-before-compile — the compilers
 *     stay dependency-free and unit-testable).
 */
import type { AiFlowDefinition, ContactRef, FlowStep } from "./types.ts";

// Minimal structural client type so this module works with the esm.sh
// supabase-js the Edge functions use without importing it here (same pattern
// as _shared/channel_settings.ts).
type ContactRefQuery = {
  eq(column: string, value: unknown): ContactRefQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
export type ContactRefSupabase = {
  from(table: string): { select(columns: string): ContactRefQuery };
};

export type ResolvedContact = { name: string; phone: string };

/**
 * Resolve a ContactRef to {name, phone} from its LIVE row. Employees come from
 * ai_flow_team_members (active only); contacts from the unified contacts table
 * (keyed by customer_e164). Returns null when the row is gone / inactive / has
 * no usable phone; THROWS on a query error so callers retry (or fall through)
 * rather than silently mis-dialing.
 */
export async function resolveContactRef(
  db: ContactRefSupabase,
  businessId: string,
  ref: Pick<ContactRef, "source" | "id">
): Promise<ResolvedContact | null> {
  if (ref.source === "employee") {
    const { data, error } = await db
      .from("ai_flow_team_members")
      .select("name, phone_e164")
      .eq("business_id", businessId)
      .eq("id", ref.id)
      .eq("active", true)
      .maybeSingle();
    if (error) throw new Error(`contact ref: roster query failed: ${error.message}`);
    const row = data as { name?: string; phone_e164?: string } | null;
    const phone = row?.phone_e164?.trim();
    if (!row || !phone) return null;
    return { name: (row.name ?? "").trim() || "teammate", phone };
  }
  const { data, error } = await db
    .from("contacts")
    .select("display_name, customer_e164")
    .eq("business_id", businessId)
    .eq("id", ref.id)
    .maybeSingle();
  if (error) throw new Error(`contact ref: contact query failed: ${error.message}`);
  const row = data as { display_name?: string; customer_e164?: string } | null;
  const phone = row?.customer_e164?.trim();
  if (!row || !phone) return null;
  return { name: (row.display_name ?? "").trim() || "contact", phone };
}

/** True when the value looks like a usable ContactRef (defensive: raw JSONB). */
function isRef(v: unknown): v is ContactRef {
  if (!v || typeof v !== "object") return false;
  const r = v as { source?: unknown; id?: unknown };
  return (r.source === "employee" || r.source === "contact") && typeof r.id === "string" && r.id.length > 0;
}

/**
 * Resolve every voice-step ContactRef in `def` into its `*E164` sibling and
 * return a NEW definition (the input — often a cached/raw JSONB read — is not
 * mutated). Non-voice steps and steps without refs pass through unchanged.
 *
 * A ref that does not resolve (deleted/inactive row, no phone) leaves the
 * E164 field unset, so the pure compilers degrade exactly like a malformed
 * step today: buildHandoffContext drops a target-less ring step,
 * compileVoiceFlow returns null for a target-less transfer, and
 * resolveOutboundCallPlan returns null without a notify number — the call
 * falls through to legacy routing instead of stranding the caller.
 *
 * Repeated refs to the same person (e.g. two ring steps to one employee) are
 * resolved once per call via a small memo. Query errors propagate (the caller
 * decides whether to fall through or fail).
 */
export async function resolveVoiceContactRefs(
  db: ContactRefSupabase,
  businessId: string,
  def: AiFlowDefinition
): Promise<AiFlowDefinition> {
  if (!def || def.trigger?.channel !== "voice" || !Array.isArray(def.steps)) return def;

  const memo = new Map<string, ResolvedContact | null>();
  const resolve = async (ref: ContactRef): Promise<ResolvedContact | null> => {
    const key = `${ref.source}:${ref.id}`;
    if (!memo.has(key)) memo.set(key, await resolveContactRef(db, businessId, ref));
    return memo.get(key) ?? null;
  };

  const steps: FlowStep[] = [];
  let changed = false;
  for (const step of def.steps) {
    if (
      (step.type === "ring_handoff" || step.type === "voice_transfer") &&
      !step.toE164 &&
      isRef(step.toRef)
    ) {
      const hit = await resolve(step.toRef);
      steps.push(hit ? { ...step, toE164: hit.phone } : step);
      changed = true;
      continue;
    }
    if (step.type === "voice_ai_intake" && !step.notifyE164 && isRef(step.notifyRef)) {
      const hit = await resolve(step.notifyRef);
      steps.push(hit ? { ...step, notifyE164: hit.phone } : step);
      changed = true;
      continue;
    }
    if (step.type === "outbound_call") {
      let next = step;
      if (!step.toE164 && isRef(step.toRef)) {
        const hit = await resolve(step.toRef);
        if (hit) next = { ...next, toE164: hit.phone };
        changed = true;
      }
      if (!step.notifyE164 && isRef(step.notifyRef)) {
        const hit = await resolve(step.notifyRef);
        if (hit) next = { ...next, notifyE164: hit.phone };
        changed = true;
      }
      steps.push(next);
      continue;
    }
    steps.push(step);
  }
  return changed ? { ...def, steps } : def;
}
