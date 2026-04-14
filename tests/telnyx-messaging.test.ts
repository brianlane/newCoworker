import { describe, it, expect, vi } from "vitest";
import { readTelnyxMessagingConfig, sendTelnyxSms } from "@/lib/telnyx/messaging";

describe("telnyx messaging", () => {
  it("readTelnyxMessagingConfig reads env", () => {
    const config = readTelnyxMessagingConfig({
      TELNYX_API_KEY: "KEY",
      TELNYX_MESSAGING_PROFILE_ID: "prof_1",
      TELNYX_SMS_FROM_E164: "+15551234567"
    });
    expect(config).toEqual({
      apiKey: "KEY",
      messagingProfileId: "prof_1",
      fromE164: "+15551234567"
    });
  });

  it("readTelnyxMessagingConfig throws when missing", () => {
    expect(() => readTelnyxMessagingConfig({})).toThrow("Missing Telnyx messaging configuration");
  });

  it("sendTelnyxSms posts to Telnyx API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "msg_abc" } })
    });
    const id = await sendTelnyxSms(
      { apiKey: "KEY", messagingProfileId: "prof", fromE164: "+15550009999" },
      "+15550001111",
      "Hello",
      fetchMock as typeof fetch
    );
    expect(id).toBe("msg_abc");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/messages",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.from).toBe("+15550009999");
  });
});
