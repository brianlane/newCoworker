/**
 * Pure builders for Amy Laidlaw's speed-to-lead conversion.
 *
 * Seller-lead routing was pinned to Dave Lane almost everywhere: one offer
 * to Dave, and a pass or timeout fell straight to the owner with nobody
 * else asked. Only HomeLight raced Dave and Amy simultaneously (PR #790).
 * This converts the normal seller routes to a three-way simultaneous offer,
 * Gabrielle Mota + Amy Laidlaw + Dave Lane, first to reply 1 wins, and
 * retargets the Clever spoke check at whoever actually claimed the lead.
 *
 * No env, no I/O, no `main()`: every export is a pure function over a
 * definition object, exactly like amy-seller-ai-call-definition.ts, so the
 * tests pin exact output and the applier
 * (amy-speed-to-lead-patch.ts) stays plumbing.
 *
 * Roster-name facts that are load-bearing: broadcast matching is by full
 * name, so "Gabrielle Mota" reaches Gabby and "Gabby" reaches NOBODY; and
 * Amy's roster row allows named_broadcast but not team_broadcast, so these
 * steps must use `agentNames` and NEVER `broadcastAll`, which would
 * silently drop her.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

type Definition = AiFlowDefinition;
type Step = Definition["steps"][number];

export const GABRIELLE_NAME = "Gabrielle Mota";
export const AMY_NAME = "Amy Laidlaw";
export const DAVE_NAME = "Dave Lane";

/** The three-way race, Gabby listed first per the ask. */
export const SPEED_TO_LEAD_NAMES = [GABRIELLE_NAME, AMY_NAME, DAVE_NAME];

/** HomeLight's literal closing line; broadcast offers end with it. */
export const FIRST_TO_CLAIM_LINE = "First to reply 1 gets it.";

/** Walk every step in the tree, including branch arms and elses. */
function walkSteps(steps: readonly Step[], visit: (s: Record<string, unknown>) => void): void {
  for (const st of steps as unknown as Record<string, unknown>[]) {
    visit(st);
    if (st.type === "branch") {
      for (const arm of (st.branches as { steps: Step[] }[]) ?? []) walkSteps(arm.steps, visit);
      walkSteps((st.else as Step[]) ?? [], visit);
    }
  }
}

function findStep(def: Definition, stepId: string): Record<string, unknown> {
  let found: Record<string, unknown> | undefined;
  walkSteps(def.steps as Step[], (st) => {
    if (st.id === stepId) found = st;
  });
  if (!found) {
    throw new Error(`step "${stepId}" not found; the live flow changed shape, re-read it before patching`);
  }
  return found;
}

/**
 * Convert a Dave-pinned route_to_team into the three-way broadcast:
 * - the `agentName` pin becomes `agentNames` (all three, simultaneously,
 *   one shared deadline, first "1" claims);
 * - the offer gains the first-to-claim closing line when absent, because
 *   three people reading the same text need to know it is a race;
 * - the "Dave didn't claim" fallback lead-in becomes nobody-claimed
 *   wording, since the fallback now means ALL THREE passed or timed out.
 * False when the step already broadcasts to the full trio.
 */
export function convertRouteToBroadcast(def: Definition, stepId: string): boolean {
  const step = findStep(def, stepId);
  if (step.type !== "route_to_team") {
    throw new Error(`step "${stepId}" is ${String(step.type)}, not route_to_team`);
  }
  const existing = Array.isArray(step.agentNames) ? (step.agentNames as string[]) : [];
  const alreadyFullTrio =
    existing.length === SPEED_TO_LEAD_NAMES.length &&
    SPEED_TO_LEAD_NAMES.every((n) => existing.includes(n));
  let changed = false;
  if (!alreadyFullTrio) {
    step.agentNames = [...SPEED_TO_LEAD_NAMES];
    delete step.agentName;
    delete step.agentRef;
    changed = true;
  }
  if (typeof step.offerTemplate === "string" && !step.offerTemplate.includes(FIRST_TO_CLAIM_LINE)) {
    step.offerTemplate = `${step.offerTemplate.replace(/\n*$/, "")}\n${FIRST_TO_CLAIM_LINE}`;
    changed = true;
  }
  if (typeof step.ownerFallbackTemplate === "string") {
    // Both live variants: "Dave didn't claim the ..." (ReferralExchange)
    // and "Dave Lane didn't claim the ..." (New Lead Intake).
    const rewritten = step.ownerFallbackTemplate.replace(
      /^Dave(?: Lane)? didn't claim the /,
      "Nobody claimed the "
    );
    if (rewritten !== step.ownerFallbackTemplate) {
      step.ownerFallbackTemplate = rewritten;
      changed = true;
    }
  }
  return changed;
}

/**
 * Add one member to an EXISTING broadcast list (HomeLight, which already
 * races Dave and Amy). False when they are already on it.
 */
export function addBroadcastRecipient(def: Definition, stepId: string, name: string): boolean {
  const step = findStep(def, stepId);
  const names = Array.isArray(step.agentNames) ? (step.agentNames as string[]) : undefined;
  if (!names) {
    throw new Error(`step "${stepId}" has no agentNames broadcast to extend`);
  }
  if (names.includes(name)) return false;
  // First in the list, matching the trio's order elsewhere; order does not
  // change delivery (simultaneous), only display.
  step.agentNames = [name, ...names];
  return true;
}

/**
 * Point the ai_call_1/2/3 ladder at the rotating trio: Dave and Gabby take
 * turns ringing first (rotateFirst 2, cursor on the roster row), Amy stays
 * the last resort, and the post-call summary follows whoever rang first on
 * that call instead of always texting Dave. False when every call step
 * already carries the rotated shape.
 */
export function addReachRotation(
  def: Definition,
  refs: { dave: Ref; gabby: Ref; amy: Ref }
): boolean {
  let changed = false;
  walkSteps(def.steps as Step[], (st) => {
    if (st.type !== "place_ai_call" || typeof st.id !== "string" || !/^ai_call_[123]$/.test(st.id)) {
      return;
    }
    const ladder = (st.reachTeammate ?? {}) as Record<string, unknown>;
    const currentIds = Array.isArray(ladder.refs)
      ? (ladder.refs as { id: string }[]).map((r) => r.id)
      : [];
    const wantedIds = [refs.dave.id, refs.gabby.id, refs.amy.id];
    const sameLadder =
      currentIds.length === wantedIds.length &&
      currentIds.every((id, i) => id === wantedIds[i]) &&
      ladder.rotateFirst === 2;
    if (!sameLadder) {
      st.reachTeammate = {
        ...ladder,
        refs: [refs.dave, refs.gabby, refs.amy],
        rotateFirst: 2
      };
      changed = true;
    }
    if (st.notifyFirstReachTarget !== true) {
      st.notifyFirstReachTarget = true;
      delete st.notifyRef;
      delete st.notifyE164;
      delete st.notifyOwner;
      changed = true;
    }
  });
  return changed;
}

/** A saved employee ref, resolved by the applier at apply time. */
export type Ref = { id: string; label: string; source: "employee" };

/**
 * Retarget the spoke check from pinned Dave to whoever claimed the lead.
 *
 * The flow triggers on owner_assigned, whose windowText carries an
 * `owner: <claimer>` line, so `read_contact` gains an extract field for it
 * and the route step swaps its `agentName` pin for `agentNameVar`. An
 * unresolvable or empty value degrades safely: empty means un-pinned
 * cascade, a non-matching name goes to owner fallback, never a wrong
 * teammate.
 *
 * Templates stay NEUTRAL (no {{vars.spoke_owner}}): route templates do not
 * collapse empty vars, and runs parked in the 3-day grace at apply time
 * never extracted it. The weekly-call context's literal "Dave Lane" line is
 * neutralized for the same reason.
 */
export const SPOKE_OWNER_VAR = "spoke_owner";

export function retargetSpokeCheck(def: Definition): boolean {
  let changed = false;
  const read = findStep(def, "read_contact");
  const fields = read.fields as { name: string; description: string }[] | undefined;
  if (!Array.isArray(fields)) throw new Error("read_contact has no fields array");
  if (!fields.some((f) => f.name === SPOKE_OWNER_VAR)) {
    fields.push({
      name: SPOKE_OWNER_VAR,
      description:
        "The teammate's name from the 'owner:' line of the assignment notice, exactly as written (e.g. 'Dave Lane'), or 'none' when no owner line is present"
    });
    changed = true;
  }
  const route = findStep(def, "spoke_check");
  if (route.agentNameVar !== SPOKE_OWNER_VAR) {
    route.agentNameVar = SPOKE_OWNER_VAR;
    delete route.agentName;
    delete route.agentRef;
    changed = true;
  }
  if (typeof route.ownerFallbackTemplate === "string") {
    const rewritten = route.ownerFallbackTemplate.replace(
      /no confirmation from Dave Lane/,
      "no confirmation from the assigned teammate"
    );
    if (rewritten !== route.ownerFallbackTemplate) {
      route.ownerFallbackTemplate = rewritten;
      changed = true;
    }
  }
  // The weekly calls still transfer to Dave's static ref (out of scope: no
  // dynamic transfer-ref mechanism exists), but the call prompt must not
  // promise Dave BY NAME to a lead that Gabby claimed.
  walkSteps(def.steps as Step[], (st) => {
    if (st.type !== "place_ai_call" || typeof st.contextTemplate !== "string") return;
    const neutral = st.contextTemplate.replace(
      /The team member who will speak with them: Dave Lane\./,
      "A team member is standing by to speak with them."
    );
    if (neutral !== st.contextTemplate) {
      st.contextTemplate = neutral;
      changed = true;
    }
  });
  return changed;
}
