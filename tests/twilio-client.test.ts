import { describe, expect, it, vi } from "vitest";
import { readTwilioConfig, sendOwnerSms } from "@/lib/twilio/client";

describe("twilio client", () => {
  it("reads config from env", () => {
    const config = readTwilioConfig({
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "token",
      TWILIO_MESSAGING_SERVICE_SID: "MG123"
    });
    expect(config.accountSid).toBe("AC123");
  });

  it("throws when config is missing", () => {
    expect(() => readTwilioConfig({})).toThrow("Missing Twilio configuration");
  });

  it("sends sms with injected client factory", async () => {
    const createMock = vi.fn(async () => ({ sid: "SM123" }));
    const twilioFactory = vi.fn(() => ({
      messages: { create: createMock }
    }));

    const sid = await sendOwnerSms(
      {
        accountSid: "AC123",
        authToken: "token",
        messagingServiceSid: "MG123"
      },
      "+15555550100",
      "test",
      twilioFactory as any
    );

    expect(sid).toBe("SM123");
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
