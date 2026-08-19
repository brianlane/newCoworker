import { describe, expect, it } from "vitest";
import {
  ownerPhoneDeliverabilityWarning,
  smsReachability
} from "@/lib/phone/deliverability";

describe("smsReachability", () => {
  it("classifies NANP numbers as reachable, Canada and Caribbean included", () => {
    expect(smsReachability("+16025550100")).toBe("nanp");
    expect(smsReachability("+15145188192")).toBe("nanp");
    expect(smsReachability("+18765550123")).toBe("nanp");
  });

  it("treats local-format input as NANP: the save path coerces it to +1", () => {
    expect(smsReachability("602 555 0147")).toBe("nanp");
    expect(smsReachability("(602) 555-0147")).toBe("nanp");
    expect(smsReachability("")).toBe("nanp");
  });

  it("stays quiet on a partial international prefix while the user is typing", () => {
    // Fewer than 7 digits is not yet a number; warning early would flicker
    // on every keystroke of a +1 number's country code.
    expect(smsReachability("+8")).toBe("nanp");
    expect(smsReachability("+852")).toBe("nanp");
    expect(smsReachability("+52 55")).toBe("nanp");
  });

  it("classifies Mexico separately once the number is plausibly complete", () => {
    expect(smsReachability("+525512345678")).toBe("mx");
    expect(smsReachability("+52 55 1234 5678")).toBe("mx");
  });

  it("classifies every other non-NANP destination as international", () => {
    expect(smsReachability("+85261234567")).toBe("international");
    expect(smsReachability("+447700900123")).toBe("international");
    expect(smsReachability("+45 12 34 56 78")).toBe("international");
  });
});

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

  it("names WhatsApp as the working channel in BOTH unreachable branches", () => {
    // Since the WhatsApp alert stand-in shipped (PR #1318), WhatsApp is a
    // real replacement channel for any number SMS cannot reach, not an
    // MX-only aside, and the warning must say so (KYP Ads +852, Jul 30
    // 2026: the owner was told to check his number's settings instead).
    expect(ownerPhoneDeliverabilityWarning("+525512345678")).toMatch(/WhatsApp/);
    expect(ownerPhoneDeliverabilityWarning("+85261234567")).toMatch(/WhatsApp/);
  });
});
