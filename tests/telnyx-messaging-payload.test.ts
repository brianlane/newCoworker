import { describe, expect, it } from "vitest";
import { telnyxMessagingPhoneString } from "../supabase/functions/_shared/telnyx_messaging_payload";

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
});
