import { describe, expect, it } from "vitest";
import {
  claimBlockedByOwner,
  ownerConflictReplyText
} from "../supabase/functions/_shared/ai_flows/claim_owner_gate";

/**
 * The contact-ownership claim gate (claim_owner_gate.ts). The scenario the
 * policy exists for: Austin Happ arrived as a seller and a buyer lead two
 * seconds apart (2026-08-08); Dave claimed the seller in 53 seconds and
 * Gabrielle claimed the buyer 28 minutes later, splitting one contact
 * across two teammates.
 */

const DAVE = "+16025245719";
const GABBY = "+14807202013";

describe("claimBlockedByOwner", () => {
  it("blocks a different teammate once an active owner exists", () => {
    expect(
      claimBlockedByOwner({ phone: DAVE, name: "Dave Lane", active: true }, GABBY)
    ).toBe(true);
  });

  it("always lets the owner claim their own contact's leads", () => {
    expect(claimBlockedByOwner({ phone: DAVE, name: "Dave Lane", active: true }, DAVE)).toBe(
      false
    );
  });

  it("never blocks on an unowned contact", () => {
    expect(claimBlockedByOwner(null, GABBY)).toBe(false);
  });

  it("an ex-teammate's ownership never blocks", () => {
    expect(
      claimBlockedByOwner({ phone: DAVE, name: "Dave Lane", active: false }, GABBY)
    ).toBe(false);
  });

  it("a phoneless owner row never blocks (nothing to route to anyway)", () => {
    expect(claimBlockedByOwner({ phone: "", name: "Dave Lane", active: true }, GABBY)).toBe(
      false
    );
  });
});

describe("ownerConflictReplyText", () => {
  it("names the lead and the owner, and asks nothing of the sender", () => {
    const t = ownerConflictReplyText("Dave Lane", "Austin Happ");
    expect(t).toContain("Austin Happ is already with Dave Lane");
    expect(t).toContain("they own this contact");
    expect(t).toContain("Nothing needed from you");
  });

  it("falls back gracefully when the names are blank", () => {
    const t = ownerConflictReplyText("  ", "");
    expect(t).toContain("This lead is already with another teammate");
  });

  it("contains no em dash", () => {
    expect(ownerConflictReplyText("Dave Lane", "Austin Happ").includes("\u2014")).toBe(false);
  });
});
