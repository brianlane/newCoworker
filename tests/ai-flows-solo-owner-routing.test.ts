/**
 * Source pins for the worker's solo-owner keep (maybeSoloOwnerKeep in
 * supabase/functions/ai-flow-worker/index.ts).
 *
 * The worker is Deno-side and outside `npx tsc --noEmit` and the vitest
 * coverage gate, so these pins are the CI guard for the structural claims
 * the change was reviewed on: where the short-circuit sits (after the
 * richer owner-direct and owned-contact rules, gated off auto-assign),
 * that it can never fire on a resumed run, that it never writes a claim,
 * and that the notice copy carries no claim framing. The style matches
 * tests/amy-owner-notice-policy.test.ts, which pins worker literals the
 * same way.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync("supabase/functions/ai-flow-worker/index.ts", "utf8");

/** The helper body, sliced so copy/claim pins cannot match elsewhere. */
const helperStart = worker.indexOf("async function maybeSoloOwnerKeep");
const helperEnd = worker.indexOf("\nasync function ", helperStart + 1);
const helper = worker.slice(helperStart, helperEnd);

describe("maybeSoloOwnerKeep: structure", () => {
  it("exists exactly once, next to the other keep rules", () => {
    expect(helperStart).toBeGreaterThan(-1);
    expect(worker.indexOf("async function maybeSoloOwnerKeep", helperStart + 1)).toBe(-1);
  });

  it("rotation path: runs after the auto-assign read, gated on !autoAssign", () => {
    const gate = worker.match(
      /const autoAssign = await leadAutoAssignEnabled\(supabase, run\.business_id\);[\s\S]{0,600}?if \(!autoAssign\) \{\s*\n\s*const solo = await maybeSoloOwnerKeep\(/
    );
    expect(gate).not.toBeNull();
  });

  it("rotation path: the owner-direct and owned-contact rules outrank it", () => {
    // maybeOwnerDirect keeps its nudge ladder and finalizeOwnerAssigned its
    // claim semantics; the solo keep must be the LAST special case before
    // the offer loop.
    const ownerDirectCall = worker.indexOf("await maybeOwnerDirect(supabase, run, scope, action, routing, tried)");
    const contactOwnerCall = worker.indexOf("await activeContactOwner(supabase, run.business_id, scope)");
    const rotationSoloCall = worker.search(
      /if \(!autoAssign\) \{\s*\n\s*const solo = await maybeSoloOwnerKeep\(/
    );
    expect(ownerDirectCall).toBeGreaterThan(-1);
    expect(contactOwnerCall).toBeGreaterThan(-1);
    expect(rotationSoloCall).toBeGreaterThan(ownerDirectCall);
    expect(rotationSoloCall).toBeGreaterThan(contactOwnerCall);
  });

  it("broadcast path: runs after the owned-contact rule, before recipient resolution", () => {
    const broadcastSolo = worker.indexOf(
      "Solo-owner keep, same rule as the rotation path"
    );
    const resolveAgents = worker.indexOf("const resolved = await resolveBroadcastAgents(");
    expect(broadcastSolo).toBeGreaterThan(-1);
    expect(resolveAgents).toBeGreaterThan(broadcastSolo);
    // And the owned-contact check sits above it inside routeBroadcastStep.
    const broadcastRegionStart = worker.indexOf("async function routeBroadcastStep");
    const ownedInBroadcast = worker.indexOf(
      "await activeContactOwner(supabase, run.business_id, scope)",
      broadcastRegionStart
    );
    expect(ownedInBroadcast).toBeGreaterThan(broadcastRegionStart);
    expect(broadcastSolo).toBeGreaterThan(ownedInBroadcast);
  });

  it("fires on first entry only: offered_log, offered_all, and tried all block it", () => {
    expect(helper).toContain("routing.offered_log");
    expect(helper).toContain("routing.offered_all");
    expect(helper).toContain("tried.length > 0");
  });

  it("keeps the lead-phone and opt-out self-guards", () => {
    expect(helper).toContain("leadPhoneE164(scope)");
    expect(helper).toContain("isRecipientOptedOut(supabase, run.business_id, solo.phone)");
  });
});

describe("maybeSoloOwnerKeep: no claim, no park", () => {
  it("stamps the no-claim trio and the permanent routing marker", () => {
    expect(helper).toContain('scope.vars.claimed_agent = "none"');
    expect(helper).toContain('scope.vars.claimed_agent_phone = "none"');
    expect(helper).toContain('scope.vars.claimed_agent_eta_minutes = "0"');
    expect(helper).toContain("routing.solo_owner = true");
  });

  it("advances the run instead of parking an offer", () => {
    expect(helper).toContain('return { kind: "ok", result: { routed: "solo_owner" } }');
    expect(helper).not.toContain("pause_agent");
    expect(helper).not.toContain("routing.offered =");
    expect(helper).not.toContain("routing.claimed_by");
  });

  it("never writes contact ownership or fires claim goals/notices", () => {
    expect(helper).not.toContain("assignContactOwnerOnClaim");
    expect(helper).not.toContain("applyGoalEvent");
    expect(helper).not.toContain("claimedNotifyTemplate");
    expect(helper).not.toContain("claimedNotifyEmail");
  });

  it("sends via sendOfferSms with a stable idempotency key", () => {
    // sendOwnerSms would silently no-op without a forward number even when
    // the roster matched via another owner number.
    expect(helper).toContain("await sendOfferSms(");
    expect(helper).toContain("`aiflow-solo-owner:${run.id}`");
    expect(helper).not.toContain("await sendOwnerSms(");
  });

  it("delivery is best-effort: a failed send logs and the run still advances", () => {
    // Same posture as the auto-assign and owner-assigned FYIs. A throwing
    // send would wedge every routed lead for a tenant whose Telnyx
    // messaging is not configured, a failure mode no other route_to_team
    // path has.
    expect(helper).toContain('event: "ai_flow_solo_owner_sms_failed"');
    expect(helper).toMatch(/try \{\s*\n\s*await sendOfferSms\(/);
  });

  it("records its own telemetry event", () => {
    expect(helper).toContain('"ai_flow_route_solo_owner"');
  });
});

describe("maybeSoloOwnerKeep: notice copy", () => {
  it("says it needs no reply and names the reason", () => {
    expect(helper).toContain("no reply needed");
    expect(helper).toContain("only teammate on the roster");
  });

  it("carries no claim framing and no em dash", () => {
    expect(helper).not.toContain("Reply 1");
    expect(helper).not.toContain('"86"');
    expect(helper).not.toMatch(/reply 86/i);
    expect(helper).not.toContain("—");
  });
});

describe("notify_lead_owner: solo rung", () => {
  it("fills the member only when a contact exists and nobody is stamped", () => {
    expect(worker).toMatch(
      /if \(!member && contactId\) \{\s*\n\s*const solo = await resolveSoloOwner\(supabase, run\.business_id\);\s*\n\s*if \(solo\) member = \{ id: solo\.memberId, name: solo\.name, phone: solo\.phone \};/
    );
  });
});
