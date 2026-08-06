import { describe, expect, it } from "vitest";
import { ownerPhoneDeliverabilityWarning } from "@/lib/phone/deliverability";

describe("ownerPhoneDeliverabilityWarning", () => {
  it("passes a US number", () => {
    expect(ownerPhoneDeliverabilityWarning("+16025550100")).toBeNull();
  });

  it("passes a Canadian number (the old US-only-profile warning is gone)", () => {
    // 514 = Montreal. Pre-Aug-2026 this warned on the default profile;
    // since widen-telnyx-destinations.ts every profile whitelists CA, and
    // the long codes originate NANP fine, so it must save silently.
    expect(ownerPhoneDeliverabilityWarning("+15145188192")).toBeNull();
  });

  it("passes a Caribbean NANP number (NANP is the boundary, not US/CA)", () => {
    // +1876 = Jamaica: still a +1 long-code destination our numbers can
    // originate to, so no warning.
    expect(ownerPhoneDeliverabilityWarning("+18765550123")).toBeNull();
  });

  it("passes a structurally odd +1 number (send-side coercion guards dialability)", () => {
    expect(ownerPhoneDeliverabilityWarning("+1234")).toBeNull();
  });

  it("warns for a Mexican number: the number-level block includes +52", () => {
    // Zero +52 sends exist in the account MDRs; Mexico v1 priced this
    // traffic but the long codes cannot originate it (Telnyx, Aug 6 2026).
    expect(ownerPhoneDeliverabilityWarning("+525512345678")).toMatch(/Mexican number/);
  });

  it("warns for any other non-NANP country", () => {
    // Hong Kong: the request that started all of this (and +852 also
    // requires a registered alpha sender, which is one-way only).
    expect(ownerPhoneDeliverabilityWarning("+85261234567")).toMatch(/not reachable by SMS/);
    // A floor-priced, fully-whitelisted country warns the same: the block
    // is the number type, not the destination.
    expect(ownerPhoneDeliverabilityWarning("+447700900123")).toMatch(/not reachable by SMS/);
  });
});
