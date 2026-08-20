/**
 * Source pins for the broadcast path's mid-offer ownership re-check
 * (routeBroadcastStep in supabase/functions/ai-flow-worker/index.ts).
 *
 * The bug these pin: broadcast checked the contact's owner on FIRST ENTRY
 * only. If the contact acquired an owner while the fan-out sat parked (the
 * dashboard Claim button, the owner dropdown, an unowned-lead alert answered
 * "1", or a parallel rotation lead's own owner-assign), the timeout branch
 * and the everyone-passed branch both walked into ownerFallbackOutcome, which
 * sets claimed_agent to the literal "none" and texts the business owner a
 * false "no agent claimed" notice about a lead that HAS an owner. The
 * rotation path never had this hole: it re-checks on every (re-)entry.
 *
 * The worker is Deno-side and outside `npx tsc --noEmit` and the vitest
 * coverage gate, so these pins are the CI guard for the structural claims,
 * matching the style of tests/ai-flows-solo-owner-routing.test.ts and
 * tests/amy-owner-notice-policy.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync("supabase/functions/ai-flow-worker/index.ts", "utf8");

/** routeBroadcastStep's body, sliced so pins cannot match the rotation path. */
const broadcastStart = worker.indexOf("async function routeBroadcastStep");
const broadcastEnd = worker.indexOf("\nasync function ", broadcastStart + 1);
const broadcast = worker.slice(broadcastStart, broadcastEnd);

/** The re-entry guard itself, sliced off the first-entry check below it. */
const recheckStart = broadcast.indexOf(
  'if ((event === "reject" || event === "timeout") && !pinnedAgentName) {'
);
const recheckEnd = broadcast.indexOf('if (event === "reject") {', recheckStart);
const recheck = broadcast.slice(recheckStart, recheckEnd);

describe("routeBroadcastStep: mid-offer ownership re-check", () => {
  it("exists exactly once inside the broadcast step", () => {
    expect(broadcastStart).toBeGreaterThan(-1);
    expect(recheckStart).toBeGreaterThan(-1);
    expect(
      broadcast.indexOf(
        'if ((event === "reject" || event === "timeout") && !pinnedAgentName) {',
        recheckStart + 1
      )
    ).toBe(-1);
  });

  it("runs on BOTH re-entry events, so neither fallback can fire on an owned contact", () => {
    // The two branches that reach ownerFallbackOutcome are the reject
    // (everyone-passed) branch and the timeout branch; the guard covers both
    // by sitting above them rather than being duplicated inside each.
    expect(recheck).toContain('event === "reject"');
    expect(recheck).toContain('event === "timeout"');
  });

  it("sits ABOVE the reject and timeout branches, so it precedes every fallback", () => {
    const rejectBranch = broadcast.indexOf('if (event === "reject") {');
    const timeoutBranch = broadcast.indexOf('if (event === "timeout") {');
    const firstFallback = broadcast.indexOf("await ownerFallbackOutcome(");
    const remind = broadcast.indexOf("await remindOrOwnerFallback(");
    expect(rejectBranch).toBeGreaterThan(recheckStart);
    expect(timeoutBranch).toBeGreaterThan(recheckStart);
    expect(firstFallback).toBeGreaterThan(recheckStart);
    expect(remind).toBeGreaterThan(recheckStart);
  });

  it("finalizes through the shared owner-assign path, not a hand-rolled claim", () => {
    expect(recheck).toContain("await activeContactOwner(supabase, run.business_id, scope)");
    expect(recheck).toContain("return finalizeOwnerAssigned(");
    // The false-notice sender must never be reachable from this guard.
    expect(recheck).not.toContain("ownerFallbackOutcome");
    expect(recheck).not.toContain('claimed_agent = "none"');
  });

  it("keeps a pinned step pinned, matching the rotation rule", () => {
    // A PINNED step reaches routeBroadcastStep whenever a reminder ladder
    // parked it as a broadcast (the parkedAsBroadcast resume), so the pin
    // gate is load-bearing here, not decorative.
    expect(recheck).toContain("!pinnedAgentName");
    expect(broadcast).toContain("pinnedAgentName?: string");
  });

  it("clears the park state, so no stale broadcast pointer outlives the step", () => {
    // routing is per RUN: a leftover offered_all would send a LATER
    // route_to_team step down the broadcast state machine on its first entry.
    for (const key of [
      "delete routing.offered;",
      "delete routing.offered_name;",
      "delete routing.offered_all;",
      "delete routing.offered_names;",
      "delete routing.offer_deadline_ms;",
      "delete routing.reminder_rounds;"
    ]) {
      expect(recheck).toContain(key);
    }
  });
});

describe("routeBroadcastStep: the pin reaches the step", () => {
  it("takes pinnedAgentName as its last parameter", () => {
    expect(broadcast).toMatch(
      /async function routeBroadcastStep\([\s\S]*?stepIndex: number,\s*\n\s*pinnedAgentName\?: string\s*\n\)/
    );
  });

  it("routeToTeamStep passes its resolved pin through at the call site", () => {
    expect(worker).toMatch(
      /return routeBroadcastStep\(\s*\n\s*supabase,\s*\n\s*run,\s*\n\s*scope,\s*\n\s*action,\s*\n\s*routing,\s*\n\s*tried,\s*\n\s*stepIndex,\s*\n\s*pinnedAgentName\s*\n\s*\);/
    );
  });
});

describe("rotation parity is preserved", () => {
  it("the rotation path keeps its own every-(re-)entry check", () => {
    // The fix mirrors this rule into broadcast; it must not move or weaken it.
    expect(worker).toMatch(
      /if \(!pinnedAgentName\) \{\s*\n\s*const contactOwner = await activeContactOwner\(supabase, run\.business_id, scope\);\s*\n\s*if \(contactOwner\) \{\s*\n\s*return finalizeOwnerAssigned\(/
    );
  });

  it("broadcast still checks ownership on first entry too", () => {
    // The pre-existing first-entry check is untouched: it is unconditional
    // there because a genuine broadcast step carries no single-agent pin.
    const firstEntry = broadcast.indexOf("// Owned contact: the fan-out never starts");
    expect(firstEntry).toBeGreaterThan(recheckStart);
    expect(
      broadcast.indexOf("await activeContactOwner(supabase, run.business_id, scope)", firstEntry)
    ).toBeGreaterThan(firstEntry);
  });

  it("ownerFallbackOutcome still exists and still states the no-claim outcome", () => {
    // Pinning the thing the fix routes AROUND: it stays correct for the case
    // it is actually for, a lead nobody owns and nobody claimed.
    const start = worker.indexOf("async function ownerFallbackOutcome");
    const body = worker.slice(start, worker.indexOf("\nasync function ", start + 1));
    expect(body).toContain('scope.vars.claimed_agent = "none"');
    expect(body).toContain("no agent claimed the lead; handed back to the owner");
  });
});
