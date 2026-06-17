import { describe, expect, it } from "vitest";
import {
  telnyxMessagingParticipants,
  telnyxMessagingPhoneString
} from "../supabase/functions/_shared/telnyx_messaging_payload";

describe("telnyxMessagingPhoneString", () => {
  it("reads string to", () => {
    expect(telnyxMessagingPhoneString({ to: "+15551234567" }, "to")).toBe("+15551234567");
  });

  it("reads array of objects (Telnyx message.received shape)", () => {
    expect(
      telnyxMessagingPhoneString(
        { to: [{ phone_number: "+15559876543", status: "webhook" }] },
        "to"
      )
    ).toBe("+15559876543");
  });

  it("reads single object with phone_number", () => {
    expect(
      telnyxMessagingPhoneString({ to: { phone_number: "+15551112222" } }, "to")
    ).toBe("+15551112222");
  });

  it("returns undefined for empty array", () => {
    expect(telnyxMessagingPhoneString({ to: [] }, "to")).toBeUndefined();
  });

  it("does not treat array as string (regression)", () => {
    const payload = { to: [{ phone_number: "+15550001001" }] };
    expect(Array.isArray(payload.to)).toBe(true);
    expect(telnyxMessagingPhoneString(payload, "to")).toBe("+15550001001");
  });

  it("reads from field", () => {
    expect(telnyxMessagingPhoneString({ from: "+15550002002" }, "from")).toBe("+15550002002");
  });

  it("returns undefined when object phone_number is not a string", () => {
    expect(telnyxMessagingPhoneString({ to: { phone_number: 555 } }, "to")).toBeUndefined();
    expect(telnyxMessagingPhoneString({ to: { foo: "bar" } }, "to")).toBeUndefined();
  });

  it("returns undefined when array first element lacks string phone_number", () => {
    expect(telnyxMessagingPhoneString({ to: [{ phone_number: null }] }, "to")).toBeUndefined();
    expect(telnyxMessagingPhoneString({ to: [{}] }, "to")).toBeUndefined();
    expect(telnyxMessagingPhoneString({ to: ["+15551234567"] }, "to")).toBeUndefined();
  });
});

describe("telnyxMessagingParticipants", () => {
  it("collects the sender plus every `to` recipient (group MMS), from-first", () => {
    const payload = {
      from: { phone_number: "+14805550001" },
      to: [{ phone_number: "+16025550000" }, { phone_number: "+14805550002" }]
    };
    expect(telnyxMessagingParticipants(payload)).toEqual([
      "+14805550001",
      "+16025550000",
      "+14805550002"
    ]);
  });

  it("de-dupes a number that appears in both from and to, preserving first-seen order", () => {
    const payload = {
      from: "+14805550001",
      to: [{ phone_number: "+14805550001" }, { phone_number: "+16025550000" }]
    };
    expect(telnyxMessagingParticipants(payload)).toEqual(["+14805550001", "+16025550000"]);
  });

  it("handles a plain 1:1 message (single from + single to)", () => {
    expect(
      telnyxMessagingParticipants({ from: "+14805550001", to: "+16025550000" })
    ).toEqual(["+14805550001", "+16025550000"]);
  });

  it("ignores non-string / missing phone numbers", () => {
    expect(
      telnyxMessagingParticipants({ from: { phone_number: 555 }, to: [{ foo: "bar" }, {}] })
    ).toEqual([]);
  });

  it("reads bare string array items and skips empty strings", () => {
    // Telnyx normally sends objects, but a bare-string array (and an empty
    // `from`) must still parse without crashing.
    expect(
      telnyxMessagingParticipants({ from: "", to: ["+14805550003", ""] })
    ).toEqual(["+14805550003"]);
  });

  it("returns [] when both fields are missing", () => {
    expect(telnyxMessagingParticipants({})).toEqual([]);
  });

  it("skips non-string array items (number) entirely", () => {
    expect(telnyxMessagingParticipants({ to: [42, { phone_number: "+14805550004" }] })).toEqual([
      "+14805550004"
    ]);
  });
});
