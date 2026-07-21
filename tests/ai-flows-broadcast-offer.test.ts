import { describe, expect, it } from "vitest";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";
import { parseRouting } from "../supabase/functions/_shared/ai_flows/routing";
import {
  matchLateClaimReply,
  type LateClaimCandidate
} from "../supabase/functions/_shared/ai_flows/late_claim";
import {
  classifyStaleOfferReply,
  type StaleOfferCandidate
} from "../supabase/functions/_shared/ai_flows/stale_offer";

const DAVE = "+16025550001";
const AMY = "+16025550002";
const GABBY = "+16025550003";

// ---------------------------------------------------------------------------
// Schema: route_to_team agentNames (broadcast mode)
// ---------------------------------------------------------------------------

const routed = (route: Record<string, unknown>) => ({
  version: 1,
  trigger: { channel: "sms", conditions: [] },
  steps: [
    {
      id: "route",
      type: "route_to_team",
      offerTemplate: "New lead — reply 1 to claim or 2 to pass",
      ownerFallbackTemplate: "No one claimed it — back to you",
      ...route
    }
  ]
});

function expectIssues(input: unknown, pattern: RegExp): void {
  try {
    parseAiFlowDefinition(input);
    expect.unreachable("expected validation to fail");
  } catch (e) {
    expect(e).toBeInstanceOf(AiFlowValidationError);
    expect((e as AiFlowValidationError).issues.join("\n")).toMatch(pattern);
  }
}

describe("route_to_team agentNames schema", () => {
  it("parses a broadcast list of roster names", () => {
    const def = parseAiFlowDefinition(routed({ agentNames: ["Dave Lane", "Amy Laidlaw"] }));
    expect(def.steps[0]).toMatchObject({ agentNames: ["Dave Lane", "Amy Laidlaw"] });
  });

  it("rejects agentNames alongside agentName (broadcast vs single pin)", () => {
    expectIssues(
      routed({ agentNames: ["Dave Lane", "Amy Laidlaw"], agentName: "Dave Lane" }),
      /broadcast and single-agent pinning are mutually exclusive/
    );
  });

  it("rejects agentNames alongside agentRef", () => {
    expectIssues(
      routed({
        agentNames: ["Dave Lane", "Amy Laidlaw"],
        agentRef: { source: "employee", id: "8b6cf4f3-8a35-41ac-b21f-465f4dbb0b82" }
      }),
      /broadcast and single-agent pinning are mutually exclusive/
    );
  });

  it("rejects duplicate names (case- and whitespace-insensitively)", () => {
    expectIssues(
      routed({ agentNames: ["Dave Lane", " dave lane "] }),
      /lists " dave lane " more than once/
    );
  });

  it("rejects fewer than 2 names (a single recipient is agentName's job)", () => {
    expect(() => parseAiFlowDefinition(routed({ agentNames: ["Dave Lane"] }))).toThrow();
  });

  it("rejects more than 10 names", () => {
    const names = Array.from({ length: 11 }, (_, i) => `Agent ${i}`);
    expect(() => parseAiFlowDefinition(routed({ agentNames: names }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Planner: agentNames passthrough
// ---------------------------------------------------------------------------

describe("planStep: route_to_team agentNames passthrough", () => {
  const base: FlowStep = {
    id: "r",
    type: "route_to_team",
    offerTemplate: "New lead, reply 1/2",
    ownerFallbackTemplate: "No one claimed it"
  };

  it("carries a trimmed broadcast list through unrendered", () => {
    const r = planStep({ ...base, agentNames: [" Dave Lane ", "Amy Laidlaw"] }, {});
    expect(
      r.ok && r.action.kind === "route_to_team" ? r.action.agentNames : null
    ).toEqual(["Dave Lane", "Amy Laidlaw"]);
  });

  it("drops the field when trimming leaves fewer than 2 names", () => {
    const r = planStep({ ...base, agentNames: ["Dave Lane", "   "] }, {});
    expect(r.ok && r.action.kind === "route_to_team" && "agentNames" in r.action).toBe(false);
  });

  it("omits the field entirely when not configured", () => {
    const r = planStep(base, {});
    expect(r.ok && r.action.kind === "route_to_team" && "agentNames" in r.action).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routing contract: offered_all / offered_names / offer_deadline_ms
// ---------------------------------------------------------------------------

describe("parseRouting broadcast fields", () => {
  it("passes well-typed broadcast fields through", () => {
    const parsed = parseRouting({
      offered_all: [DAVE, AMY],
      offered_names: { [DAVE]: "Dave Lane", [AMY]: "Amy Laidlaw" },
      offer_deadline_ms: 1753050000000
    });
    expect(parsed.offered_all).toEqual([DAVE, AMY]);
    expect(parsed.offered_names).toEqual({ [DAVE]: "Dave Lane", [AMY]: "Amy Laidlaw" });
    expect(parsed.offer_deadline_ms).toBe(1753050000000);
  });

  it("filters non-string members from offered_all and drops malformed fields", () => {
    const parsed = parseRouting({
      offered_all: [DAVE, 42, null],
      offered_names: "not-an-object",
      offer_deadline_ms: "soon"
    });
    expect(parsed.offered_all).toEqual([DAVE]);
    expect(parsed.offered_names).toBeUndefined();
    expect(parsed.offer_deadline_ms).toBeUndefined();
  });

  it("drops non-string values inside offered_names and rejects array shapes", () => {
    const parsed = parseRouting({
      offered_names: { [DAVE]: "Dave Lane", [AMY]: 7 }
    });
    expect(parsed.offered_names).toEqual({ [DAVE]: "Dave Lane" });
    expect(parseRouting({ offered_names: ["Dave Lane"] }).offered_names).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Late-claim matcher: broadcast offerees are LIVE
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-07-20T20:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let nextId = 0;
function claimRow(
  over: Partial<LateClaimCandidate> & { routing?: Record<string, unknown> }
): LateClaimCandidate {
  const { routing, ...rest } = over;
  nextId += 1;
  return {
    id: `run-${nextId}`,
    status: "awaiting_agent",
    context: { routing: routing ?? {} },
    awaiting_agent_e164: null,
    current_step: 3,
    updated_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    revision: 1,
    ...rest
  };
}

function matchClaim(
  candidates: LateClaimCandidate[],
  opts: { from?: string; digit?: string; timeframe?: string } = {}
) {
  return matchLateClaimReply({
    candidates,
    from: opts.from ?? DAVE,
    digit: opts.digit ?? "1",
    timeframe: opts.timeframe ?? "",
    nowMs: NOW,
    windowMs: DAY_MS
  });
}

/** A live broadcast offer to Dave + Amy (routing.offered stays unset). */
function broadcastRow(extraRouting: Record<string, unknown> = {}): LateClaimCandidate {
  return claimRow({
    routing: {
      offered_all: [DAVE, AMY],
      offered_names: { [DAVE]: "Dave Lane", [AMY]: "Amy Laidlaw" },
      offered_log: [DAVE, AMY],
      step_index: 3,
      ...extraRouting
    }
  });
}

describe("matchLateClaimReply — broadcast offers", () => {
  it("a broadcast offeree's '1' is LIVE (bare or with ETA)", () => {
    const r = broadcastRow();
    expect(matchClaim([r])).toEqual({ kind: "live", row: r, stepIndex: 3 });
    expect(matchClaim([r], { from: AMY, timeframe: "20 min" })?.kind).toBe("live");
  });

  it("a non-offeree never matches a broadcast run", () => {
    expect(matchClaim([broadcastRow()], { from: GABBY })).toBeNull();
  });

  it("a passer (removed from offered_all, still in offered_log) can bare-'1' yank the live broadcast", () => {
    const r = broadcastRow({ offered_all: [AMY] });
    expect(matchClaim([r])).toEqual({ kind: "yank", row: r, stepIndex: 3 });
    // "1, <eta>" from outside the live set never preempts the countdown.
    expect(matchClaim([r], { timeframe: "2 hours" })).toBeNull();
  });

  it("a broadcast run claimed by someone else is unavailable", () => {
    const r = broadcastRow({ claimed_by: AMY });
    expect(matchClaim([r])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stale-offer classifier: broadcast awareness
// ---------------------------------------------------------------------------

function staleRow(
  over: Partial<StaleOfferCandidate> & { routing?: Record<string, unknown> }
): StaleOfferCandidate {
  const { routing, ...rest } = over;
  nextId += 1;
  return {
    id: `stale-${nextId}`,
    status: "awaiting_agent",
    context: { routing: routing ?? {} },
    awaiting_agent_e164: null,
    updated_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    ...rest
  };
}

function classify(
  candidates: StaleOfferCandidate[],
  opts: { from?: string; digit?: string } = {}
) {
  return classifyStaleOfferReply({
    candidates,
    from: opts.from ?? DAVE,
    digit: opts.digit ?? "1",
    nowMs: NOW,
    windowMs: DAY_MS
  });
}

describe("classifyStaleOfferReply — broadcast offers", () => {
  const liveBroadcastRouting = {
    offered_all: [DAVE, AMY],
    offered_log: [DAVE, AMY],
    step_index: 3
  };

  it("a live broadcast offeree's digit is the upstream live path's job (null)", () => {
    expect(classify([staleRow({ routing: liveBroadcastRouting })])).toBeNull();
  });

  it("a passer replying '1' while the broadcast is live with others is taught the bare-'1' yank", () => {
    const r = staleRow({
      routing: { ...liveBroadcastRouting, offered_all: [AMY], tried: [DAVE] }
    });
    expect(classify([r])).toEqual({ runId: r.id, kind: "live_with_other", claimedName: "" });
  });

  it("a broadcast lead claimed by someone else names the claimer", () => {
    const r = staleRow({
      status: "done",
      routing: {
        offered_all: [],
        offered_log: [DAVE, AMY],
        tried: [DAVE],
        claimed_by: AMY,
        claimed_name: "Amy Laidlaw"
      }
    });
    expect(classify([r])).toEqual({
      runId: r.id,
      kind: "claimed_by_other",
      claimedName: "Amy Laidlaw"
    });
  });

  it("a broadcast offeree is recognized as ever-offered via offered_all alone", () => {
    // No tried/awaiting/offered entry for Amy — only offered_all membership.
    const r = staleRow({
      status: "done",
      routing: { offered_all: [AMY], offered_log: [AMY], claimed_by: DAVE, claimed_name: "Dave" }
    });
    expect(classify([r], { from: AMY })?.kind).toBe("claimed_by_other");
  });
});
