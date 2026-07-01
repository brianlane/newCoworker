import { describe, it, expect } from "vitest";
import {
  buildOwnerMessage,
  buildRecipientMessage,
  encodeWtClientState,
  labelFor,
  parseWtClientState,
  recipientIsOwner,
  shouldNotifyOwner
} from "../supabase/functions/_shared/warm_transfer_notify";

const BIZ = "11111111-2222-3333-4444-555555555555";

describe("warm_transfer_notify client_state", () => {
  it("round-trips encode -> parse with a plain string", () => {
    const cs = encodeWtClientState({
      businessId: BIZ,
      callerE164: "+16026866672",
      recipientE164: "+16025245719"
    });
    expect(cs).toBe(`wt:${BIZ}:+16026866672:+16025245719`);
    expect(parseWtClientState(cs)).toEqual({
      businessId: BIZ,
      callerE164: "+16026866672",
      recipientE164: "+16025245719"
    });
  });

  it("parses a base64-encoded client_state (as Telnyx echoes it)", () => {
    const plain = encodeWtClientState({
      businessId: BIZ,
      callerE164: "+16026866672",
      recipientE164: "+16025245719"
    });
    const b64 = Buffer.from(plain, "utf8").toString("base64");
    expect(parseWtClientState(b64)).toEqual({
      businessId: BIZ,
      callerE164: "+16026866672",
      recipientE164: "+16025245719"
    });
  });

  it("round-trips an anonymous caller (empty caller number)", () => {
    const cs = encodeWtClientState({ businessId: BIZ, callerE164: "", recipientE164: "+1602" });
    expect(parseWtClientState(cs)).toEqual({
      businessId: BIZ,
      callerE164: "",
      recipientE164: "+1602"
    });
  });

  it("returns null for missing / non-wt / malformed client_state", () => {
    expect(parseWtClientState(undefined)).toBeNull();
    expect(parseWtClientState("")).toBeNull();
    // Invalid base64 (atob throws) → null.
    expect(parseWtClientState("not-base64-and-not-wt")).toBeNull();
    // hl: leg (invalid base64 due to ':') → null.
    expect(parseWtClientState("hl:cc-abc:1")).toBeNull();
    // Valid base64 that decodes to a non-wt string → null.
    expect(parseWtClientState(Buffer.from("hello", "utf8").toString("base64"))).toBeNull();
    // Wrong segment count.
    expect(parseWtClientState(`wt:${BIZ}:+1602`)).toBeNull();
    // Missing business id.
    expect(parseWtClientState("wt::+1602:+1603")).toBeNull();
    // Missing recipient.
    expect(parseWtClientState(`wt:${BIZ}:+1602:`)).toBeNull();
  });
});

describe("shouldNotifyOwner / recipientIsOwner", () => {
  it("notifies the owner only when a distinct owner number exists", () => {
    expect(shouldNotifyOwner("+1602team", "+1602owner")).toBe(true);
    expect(shouldNotifyOwner("+1602owner", "+1602owner")).toBe(false);
    expect(shouldNotifyOwner("+1602team", "")).toBe(false);
    expect(shouldNotifyOwner("+1602team", undefined)).toBe(false);
    // Whitespace tolerance.
    expect(shouldNotifyOwner(" +1602owner ", "+1602owner")).toBe(false);
  });

  it("recipientIsOwner is the inverse for a present owner number", () => {
    expect(recipientIsOwner("+1602owner", "+1602owner")).toBe(true);
    expect(recipientIsOwner("+1602team", "+1602owner")).toBe(false);
    expect(recipientIsOwner("+1602team", "")).toBe(false);
  });
});

describe("labelFor", () => {
  it("combines name + number when both known", () => {
    expect(labelFor("Brian Lane", "+16026866672")).toBe("Brian Lane +16026866672");
  });
  it("falls back to name-only, number-only, then fallback", () => {
    expect(labelFor("Brian Lane", "")).toBe("Brian Lane");
    expect(labelFor("", "+16026866672")).toBe("+16026866672");
    expect(labelFor("", "")).toBe("the caller");
    expect(labelFor(null, null, "your teammate")).toBe("your teammate");
  });
});

describe("message builders", () => {
  it("recipient success + failure", () => {
    expect(buildRecipientMessage("success", "Brian Lane +16026866672")).toBe(
      "Warm transfer successful for Brian Lane +16026866672."
    );
    expect(buildRecipientMessage("failed", "Brian Lane +16026866672")).toBe(
      "Missed warm transfer for Brian Lane +16026866672 — please follow up."
    );
  });

  it("owner success + failure", () => {
    expect(buildOwnerMessage("success", "Dave +16025555555", "Bob Smith +16021112222")).toBe(
      "Dave +16025555555 received a successful warm transfer for Bob Smith +16021112222."
    );
    expect(buildOwnerMessage("failed", "Dave +16025555555", "Bob Smith +16021112222")).toBe(
      "Dave +16025555555 missed a warm transfer for Bob Smith +16021112222."
    );
  });

  it("uses number-only labels when names are unknown", () => {
    const callerLabel = labelFor("", "+16026866672");
    expect(buildRecipientMessage("success", callerLabel)).toBe(
      "Warm transfer successful for +16026866672."
    );
  });
});
