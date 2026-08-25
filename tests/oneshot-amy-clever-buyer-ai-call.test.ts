/**
 * The AI works a Clever buyer like a Clever seller, in buyer words
 * (scripts/oneshot/amy-clever-buyer-ai-call.ts).
 *
 * Amy asked for Clever buyers to be treated like a realestateagents.com buyer,
 * and separately asked whether the AI should work them until they are serious.
 * Those are one instruction: realestateagents.com leads run on
 * "ReferralExchange Lead", whose buyer call already offers a live transfer
 * when they are serious and records a callback time when nobody picks up.
 *
 * The trap these tests exist for: `ai_call_2` and `ai_call_3` are seller-worded
 * and gated on `call_outcome equals no_answer`, which a buyer call sets too.
 * Filling only the first arm would call a buyer twice more with a listing
 * pitch, reintroducing the bug that gating the call fixed.
 */
import { describe, expect, it } from "vitest";
import {
  BUYER_REACH_NAMES,
  BUYER_WHEN,
  CALL_GATE_STEP_ID,
  CALL_RUNGS,
  MAX_REACH_REFS,
  NOT_BUYER_WHEN,
  REFERRAL_BUYER_CALL_ID,
  REFERRAL_BUYER_REACH_PREVIOUS,
  alreadyPatched,
  buyerCallStep,
  patchBuyerCalls,
  revertBuyerCalls,
  setReach
} from "../scripts/oneshot/amy-clever-buyer-ai-call";
import { walkSteps } from "../scripts/oneshot/amy-clever-lead-type";

type Step = Record<string, unknown> & { id: string; type: string };
type Def = { steps: Step[] };
type Ref = { id: string; label: string; source: string };

const ROSTER: Record<string, Ref> = {
  "Dave Lane": { id: "dave", label: "Dave Lane", source: "employee" },
  "Gabrielle Mota": { id: "gabby", label: "Gabrielle Mota", source: "employee" },
  "Amy Laidlaw": { id: "amy", label: "Amy Laidlaw", source: "employee" },
  "Jason Lane": { id: "jason", label: "Jason Lane", source: "employee" }
};
/** The SELLER ladder, unchanged by this script. */
const SELLER_REFS: Ref[] = REFERRAL_BUYER_REACH_PREVIOUS.map((n) => ROSTER[n]);
/** The BUYER ladder: Amy off, Jason on, because only three fit. */
const REFS: Ref[] = BUYER_REACH_NAMES.map((n) => ROSTER[n]);

function sellerCall(id: string, extra: Record<string, unknown> = {}): Step {
  return {
    id,
    type: "place_ai_call",
    toVar: "lead_phone",
    saveAs: "call_outcome",
    waitMinutes: 20,
    when: { var: "price_under_1m", notEquals: "no" },
    notifyFirstReachTarget: true,
    reachTeammate: { refs: SELLER_REFS.map((r) => ({ ...r })), ringSeconds: 20, rotateFirst: 2 },
    personaTemplate: "...about selling your home on {{vars.lead_address}}...",
    ...extra
  };
}

/** The live shape after amy-clever-lead-type.ts: gate present, arm empty. */
function fixture(): Def {
  return {
    steps: [
      {
        id: CALL_GATE_STEP_ID,
        type: "branch",
        question: "Is this Clever referral a buyer or a seller?",
        branches: [
          {
            id: "clever_type_buyer",
            label: "Buyer",
            condition: { var: "lead_type", equals: "buyer" },
            steps: []
          }
        ],
        else: [sellerCall("ai_call_1")]
      },
      {
        id: "call_followups",
        type: "branch",
        question: "how did the call go?",
        branches: [
          {
            id: "cf_no_answer",
            condition: { var: "call_outcome", equals: "no_answer" },
            steps: [
              {
                id: "retry_2",
                type: "branch",
                question: "retry?",
                branches: [{ id: "retry_2_claimed", condition: { var: "claimed_agent", notEquals: "none" }, steps: [] }],
                else: [
                  sellerCall("ai_call_2", { when: undefined, callWindow: { start: "08:30", end: "21:00", outside: "skip", timezone: "America/Phoenix" } }),
                  sellerCall("ai_call_3", { when: undefined, callWindow: { start: "08:30", end: "21:00", outside: "skip", timezone: "America/Phoenix" } })
                ]
              }
            ]
          }
        ],
        else: []
      }
    ]
  };
}

const stepById = (def: Def, id: string) => walkSteps(def.steps).find((s) => s.id === id);

describe("buyerCallStep", () => {
  const rung = CALL_RUNGS[0];
  const step = () => buyerCallStep(rung, sellerCall("ai_call_1"), REFS);

  it("never pitches a listing, which is the whole reason the call was gated off", () => {
    const persona = String(step().personaTemplate);
    expect(persona).toContain("This lead is a BUYER");
    expect(persona).toMatch(/never pitch a listing, a valuation, or a cash offer/);
    expect(persona).not.toMatch(/selling your home/);
  });

  it("offers the live transfer and the recorded callback Amy asked for", () => {
    const persona = String(step().personaTemplate);
    expect(persona).toContain("use the reach tool to connect them to a teammate");
    expect(persona).toMatch(/ONLY THEN ask what time of day suits them best for that callback/);
  });

  it("rings Jason, the one teammate whose only roster tag is buyer", () => {
    const refs = (step().reachTeammate as { refs: Ref[] }).refs;
    expect(refs.map((r) => r.label)).toEqual(["Dave Lane", "Gabrielle Mota", "Jason Lane"]);
  });

  it("fits the cap of three, which is why Amy comes off the buyer ladder", () => {
    // Amy asked for a transfer to four people and reachTeammate.refs is
    // capped at 3: the lead is HELD on the line while each rung is dialled,
    // so the cap is a hold-time budget. Amy is the backstop and still gets an
    // unclaimed buyer through the owner fallback; Jason has no other way onto
    // a live transfer.
    expect(BUYER_REACH_NAMES).toHaveLength(MAX_REACH_REFS);
    expect(BUYER_REACH_NAMES).not.toContain("Amy Laidlaw");
    const reach = step().reachTeammate as { refs: Ref[]; rotateFirst: number };
    expect(reach.refs.length).toBeLessThanOrEqual(MAX_REACH_REFS);
    expect(reach.rotateFirst).toBeLessThanOrEqual(reach.refs.length);
  });

  it("declares the budget and area as known, so it cannot open by asking", () => {
    // The referral already gave both. Asking a buyer for what we were just
    // told is the tell of a flow that did not read its own lead.
    expect(String(step().contextTemplate)).toContain("NEVER ask for any of it");
    expect(String(step().contextTemplate)).toContain("{{vars.price}}");
    expect(String(step().personaTemplate)).toMatch(/never ask for them cold/);
  });

  it("saves to call_outcome, the var every later branch reads", () => {
    // A private var would strand a buyer: the retry ladder, the promote path
    // and the AI-owned tagging all gate on call_outcome.
    expect(step().saveAs).toBe("call_outcome");
  });

  it("keeps the $1M+ price rule on round 1, where the seller rung carries it", () => {
    // A price rule, not a seller rule: a high-dollar buyer stays Amy's own.
    expect(step().when).toEqual({ var: "price_under_1m", notEquals: "no" });
  });

  it("splits the retry rungs by lead_type, since they carry no price guard", () => {
    const r2 = CALL_RUNGS[1];
    const withWindow = buyerCallStep(
      r2,
      sellerCall("ai_call_2", { when: undefined, callWindow: { start: "08:30", end: "21:00", outside: "skip", timezone: "America/Phoenix" } }),
      REFS
    );
    expect(withWindow.when).toEqual(BUYER_WHEN);
    expect(withWindow.callWindow).toEqual({ start: "08:30", end: "21:00", outside: "skip", timezone: "America/Phoenix" });
  });

  it("carries a call-summary target, which the schema requires", () => {
    // The seller rungs send it to whoever the AI rang first, which is what
    // the team offer promises. A call with no target is rejected outright.
    expect(step().notifyFirstReachTarget).toBe(true);
  });

  it("escalates across the three rungs like the seller ladder does", () => {
    const p1 = String(buyerCallStep(CALL_RUNGS[0], sellerCall("a"), REFS).personaTemplate);
    const p2 = String(buyerCallStep(CALL_RUNGS[1], sellerCall("b"), REFS).personaTemplate);
    const p3 = String(buyerCallStep(CALL_RUNGS[2], sellerCall("c"), REFS).personaTemplate);
    expect(p1).toContain("Is now a good time?");
    expect(p2).toContain("again");
    expect(p3).toContain("one last try");
    expect(p3).toMatch(/we will stop calling/);
  });

  it("carries no em dash in anything the lead or a teammate hears", () => {
    const s = buyerCallStep(CALL_RUNGS[0], sellerCall("a"), REFS);
    for (const v of [s.personaTemplate, s.contextTemplate, (s.reachTeammate as { preSmsTemplate: string }).preSmsTemplate]) {
      expect(String(v)).not.toContain("—");
    }
  });
});

describe("patchBuyerCalls", () => {
  it("gives EVERY rung a buyer variant, not just the first", () => {
    // The trap. ai_call_2 and ai_call_3 are seller-worded and fire on
    // call_outcome equals no_answer, which the buyer call also sets.
    const def = fixture();
    const { changed, problems } = patchBuyerCalls(def, REFS);
    expect(problems).toEqual([]);
    expect(changed).toHaveLength(3);
    for (const rung of CALL_RUNGS) {
      expect(stepById(def, rung.buyerId), `${rung.buyerId} missing`).toBeTruthy();
      expect(stepById(def, rung.sellerId), `${rung.sellerId} lost`).toBeTruthy();
    }
  });

  it("fills the existing round-1 arm instead of wrapping it again", () => {
    const def = fixture();
    patchBuyerCalls(def, REFS);
    const gate = stepById(def, CALL_GATE_STEP_ID)!;
    const arm = (gate.branches as Array<{ steps: Step[] }>)[0];
    expect(arm.steps.map((s) => s.id)).toEqual(["ai_call_buyer"]);
    // And the seller call is still the else, untouched.
    expect((gate.else as Step[]).map((s) => s.id)).toEqual(["ai_call_1"]);
  });

  it("splits the retry rungs as SIBLINGS, adding no branch nesting", () => {
    // The retry ladder already sits three branches deep, and the schema
    // rejects a fourth. Two gated steps side by side are the documented
    // alternative and cost no depth.
    const def = fixture();
    patchBuyerCalls(def, REFS);
    const retry2 = stepById(def, "retry_2")!;
    expect((retry2.else as Step[]).map((s) => s.id)).toEqual([
      "ai_call_2",
      "ai_call_buyer_2",
      "ai_call_3",
      "ai_call_buyer_3"
    ]);
    expect(stepById(def, "ai_call_2")!.when).toEqual(NOT_BUYER_WHEN);
    expect(stepById(def, "ai_call_buyer_2")!.when).toEqual(BUYER_WHEN);
    expect(stepById(def, "ai_call_3")!.when).toEqual(NOT_BUYER_WHEN);
    expect(stepById(def, "ai_call_buyer_3")!.when).toEqual(BUYER_WHEN);
  });

  it("REFUSES to split a retry rung that already has a guard of its own", () => {
    // Overwriting it would silently drop whatever that guard was for.
    const def = fixture();
    stepById(def, "ai_call_3")!.when = { var: "something", equals: "else" };
    expect(patchBuyerCalls(def, REFS).problems.join(" ")).toContain("already carries a");
  });

  it("is idempotent and round-trips through revert", () => {
    const def = fixture();
    const before = JSON.parse(JSON.stringify(def));
    patchBuyerCalls(def, REFS);
    expect(alreadyPatched(def)).toBe(true);
    expect(patchBuyerCalls(def, REFS).changed).toEqual([]);
    expect(revertBuyerCalls(def).length).toBeGreaterThan(0);
    expect(def).toEqual(before);
    expect(revertBuyerCalls(def)).toEqual([]);
  });

  it("REFUSES when the round-1 gate is missing or already occupied", () => {
    const noGate = fixture();
    noGate.steps = noGate.steps.filter((s) => s.id !== CALL_GATE_STEP_ID);
    expect(patchBuyerCalls(noGate, REFS).problems.join(" ")).toContain("ai_call_1");

    const occupied = fixture();
    ((occupied.steps[0].branches as Array<{ steps: Step[] }>)[0].steps).push({
      id: "someone_elses_step",
      type: "notify_owner"
    } as Step);
    const { problems } = patchBuyerCalls(occupied, REFS);
    expect(problems.join(" ")).toContain("already holds steps");
  });

  it("REFUSES when a seller rung has gone missing", () => {
    const def = fixture();
    const retry2 = stepById(def, "retry_2")!;
    retry2.else = (retry2.else as Step[]).filter((s) => s.id !== "ai_call_3");
    expect(patchBuyerCalls(def, REFS).problems.join(" ")).toContain("ai_call_3");
  });

  it("leaves the seller rungs' own settings untouched", () => {
    const def = fixture();
    patchBuyerCalls(def, REFS);
    const seller = stepById(def, "ai_call_2")!;
    expect(String(seller.personaTemplate)).toContain("selling your home");
    expect((seller.reachTeammate as { refs: Ref[] }).refs.map((r) => r.label)).toEqual([
      "Dave Lane",
      "Gabrielle Mota",
      "Amy Laidlaw"
    ]);
  });
});

describe("setReach", () => {
  const reFlow = (): Def => ({
    steps: [
      {
        id: REFERRAL_BUYER_CALL_ID,
        type: "place_ai_call",
        reachTeammate: { refs: SELLER_REFS.map((r) => ({ ...r })), ringSeconds: 20, rotateFirst: 2 }
      } as Step
    ]
  });

  it("puts Jason on the ReferralExchange buyer transfer by replacing Amy", () => {
    // A SET, not an append: that ladder is already full at three, so Jason
    // can only join by somebody leaving.
    const def = reFlow();
    expect(setReach(def, REFERRAL_BUYER_CALL_ID, REFS)).toHaveLength(1);
    const refs = (stepById(def, REFERRAL_BUYER_CALL_ID)!.reachTeammate as { refs: Ref[] }).refs;
    expect(refs.map((r) => r.label)).toEqual(["Dave Lane", "Gabrielle Mota", "Jason Lane"]);
    expect(refs).toHaveLength(MAX_REACH_REFS);
  });

  it("leaves the rest of the ladder settings alone", () => {
    const def = reFlow();
    setReach(def, REFERRAL_BUYER_CALL_ID, REFS);
    const reach = stepById(def, REFERRAL_BUYER_CALL_ID)!.reachTeammate as Record<string, unknown>;
    expect(reach.ringSeconds).toBe(20);
    expect(reach.rotateFirst).toBe(2);
  });

  it("is idempotent and round-trips", () => {
    const def = reFlow();
    const before = JSON.parse(JSON.stringify(def));
    setReach(def, REFERRAL_BUYER_CALL_ID, REFS);
    expect(setReach(def, REFERRAL_BUYER_CALL_ID, REFS)).toEqual([]);
    expect(setReach(def, REFERRAL_BUYER_CALL_ID, SELLER_REFS)).toHaveLength(1);
    expect(def).toEqual(before);
  });

  it("does nothing when the step or its ladder is absent", () => {
    expect(setReach({ steps: [] }, REFERRAL_BUYER_CALL_ID, REFS)).toEqual([]);
    expect(
      setReach(
        { steps: [{ id: REFERRAL_BUYER_CALL_ID, type: "place_ai_call" } as Step] },
        REFERRAL_BUYER_CALL_ID,
        REFS
      )
    ).toEqual([]);
  });
});
