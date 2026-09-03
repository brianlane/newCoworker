/**
 * Source pins for the webhook's third "1" class: broadcast BOOKING claims
 * (supabase/functions/telnyx-sms-inbound/index.ts). The webhook is
 * Deno-side and outside tsc and coverage, so these pins guard the
 * structural claims: booking candidates join the bare-"1" gate and the
 * ambiguity count, the named "1, <name>" matcher can pick them (the PR
 * #1270 rule), the single-candidate branch fires only when offers and
 * alerts are absent, and the claim function never invites a reply loop.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const webhook = readFileSync("supabase/functions/telnyx-sms-inbound/index.ts", "utf8");

/** The consumeBookingClaim body, sliced so copy pins cannot match elsewhere. */
const claimStart = webhook.indexOf("async function consumeBookingClaim");
const claimEnd = webhook.indexOf("\nasync function ", claimStart + 1);
const claimFn = webhook.slice(claimStart, claimEnd);

describe("bare-1 gate", () => {
  it("fetches booking candidates only on a bare claim, like alerts", () => {
    expect(webhook).toMatch(
      /const bookingCandidates = bareClaim\s*\n\s*\? await findLiveBookingClaimsFor\(supabase, businessId, from, new Date\(\)\.toISOString\(\)\)\s*\n\s*: \[\];/
    );
  });

  it("counts unique leads, not stacked alert rows, into the ambiguity ask-back", () => {
    expect(webhook).toContain("collapseOfferCandidates([");
    expect(webhook).toContain("uniqueLeads.length > 1");
    expect(webhook).toContain("bareDigitAmbiguityText(askBackLabels(uniqueLeads))");
    expect(webhook).toContain("...bookingCandidates.map((b) => ({");
    expect(webhook).toContain("leadLabel: bookingClaimLabel(b)");
  });

  it("claims a lone booking candidate by the collapsed id, not by list position", () => {
    expect(webhook).toContain("onlyLead?.runId.startsWith(BOOKING_CANDIDATE_PREFIX)");
    expect(webhook).toContain(
      "`${BOOKING_CANDIDATE_PREFIX}${b.offerId}` === onlyLead.runId"
    );
    const alertBranch = webhook.indexOf("onlyLead?.runId.startsWith(ALERT_CANDIDATE_PREFIX)");
    const bookingBranch = webhook.indexOf(
      "onlyLead?.runId.startsWith(BOOKING_CANDIDATE_PREFIX)"
    );
    expect(alertBranch).toBeGreaterThan(-1);
    expect(bookingBranch).toBeGreaterThan(alertBranch);
  });
});

describe("named claims (1, <name>)", () => {
  it("bookings join the combined candidate list under their own prefix", () => {
    expect(webhook).toContain('const BOOKING_CANDIDATE_PREFIX = "booking:"');
    expect(webhook).toContain("runId: `${BOOKING_CANDIDATE_PREFIX}${b.offerId}`");
    expect(webhook).toMatch(
      /match\.runId\.startsWith\(BOOKING_CANDIDATE_PREFIX\)/
    );
  });

  it("collapses stacked same-phone alerts before matching the name", () => {
    expect(webhook).toContain("const combined: OfferCandidate[] = collapseOfferCandidates([");
    expect(webhook).toContain("namedNoMatchLabels = askBackLabels(combined)");
  });

  it("retires leftover alerts when an offer claim wins the collapsed race", () => {
    expect(webhook).toContain("await retireLiveUnownedAlertsForLead(supabase, {");
    const liveClaim = webhook.indexOf("async function tryAgentClaimWithTimeframe");
    const lateClaim = webhook.indexOf("async function tryLateClaim");
    expect(liveClaim).toBeGreaterThan(-1);
    expect(lateClaim).toBeGreaterThan(liveClaim);
    expect(webhook.indexOf("retireLiveUnownedAlertsForLead", liveClaim)).toBeGreaterThan(liveClaim);
    expect(webhook.indexOf("retireLiveUnownedAlertsForLead", lateClaim)).toBeGreaterThan(lateClaim);
  });
});

describe("consumeBookingClaim", () => {
  it("exists once and resolves the claimer from the roster without refusing strangers", () => {
    expect(claimStart).toBeGreaterThan(-1);
    expect(webhook.indexOf("async function consumeBookingClaim", claimStart + 1)).toBe(-1);
    expect(claimFn).toContain('.eq("phone_e164", from)');
  });

  it("acks the winner and stands the other invitees down with stable idempotency keys", () => {
    expect(claimFn).toContain("`${eventId}:booking-claim`");
    expect(claimFn).toContain("`${eventId}:booking-claim-standdown:${other}`");
    expect(claimFn).toContain("was just claimed by a teammate");
  });

  it("records telemetry and persists the reply as a team turn", () => {
    expect(claimFn).toContain('"booking_claim_offer_claim"');
    expect(claimFn).toContain('staffKind: "team"');
  });

  it("copy carries no claim-loop bait and no em dash", () => {
    expect(claimFn).not.toContain("Reply 1");
    expect(claimFn).not.toContain("—");
  });
});
