import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));

vi.mock("@/lib/sms/opt-outs", () => ({
  checkSmsOptOut: vi.fn()
}));

const { insertMock, fromMock } = vi.hoisted(() => {
  const insertMock = vi.fn();
  const fromMock = vi.fn(() => ({ insert: insertMock }));
  return { insertMock, fromMock };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({ from: fromMock }))
}));

import { POST } from "@/app/api/voice/tools/sms/route";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";

const BIZ = "11111111-1111-4111-8111-111111111111";

function req(body: unknown) {
  return new Request("http://localhost/api/voice/tools/sms", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer gw"
    },
    body: JSON.stringify(body)
  });
}

describe("POST /api/voice/tools/sms", () => {
  const OLD = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD, ROWBOAT_GATEWAY_TOKEN: "gw" };
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
    vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue({
      apiKey: "k",
      messagingProfileId: "mp",
      fromE164: "+15550001111"
    });
    vi.mocked(sendTelnyxSms).mockResolvedValue({ id: "msg_1", channel: "sms" });
    vi.mocked(checkSmsOptOut).mockResolvedValue({ ok: true, optedOut: false });
    insertMock.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    process.env = OLD;
  });

  it("sends metered SMS to the caller ANI and logs it to sms_outbound_log", async () => {
    const res = await POST(
      req({
        businessId: BIZ,
        callerE164: "+15555550100",
        args: { body: "See you tomorrow" }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, data: { messageId: "msg_1", toE164: "+15555550100" } });
    expect(sendTelnyxSms).toHaveBeenCalledWith(
      expect.anything(),
      "+15555550100",
      "See you tomorrow",
      { meterBusinessId: BIZ }
    );
    expect(fromMock).toHaveBeenCalledWith("sms_outbound_log");
    expect(insertMock).toHaveBeenCalledWith({
      business_id: BIZ,
      to_e164: "+15555550100",
      from_e164: "+15550001111",
      body: "See you tomorrow",
      source: "voice_follow_up",
      run_id: null,
      flow_id: null,
      telnyx_message_id: "msg_1",
      channel: "sms"
    });
  });

  it("still succeeds when the outbound log insert fails (the SMS already went out)", async () => {
    insertMock.mockResolvedValueOnce({ error: { message: "insert denied" } });
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { body: "hi" } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("does not log when the Telnyx send fails", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValueOnce(new Error("Monthly SMS limit reached"));
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { body: "hi" } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, detail: "sms_quota_blocked" });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns no_destination when neither toE164 nor callerE164 is present", async () => {
    const res = await POST(req({ businessId: BIZ, args: { body: "hi" } }));
    const body = await res.json();
    expect(body).toEqual({ ok: false, detail: "no_destination" });
    expect(sendTelnyxSms).not.toHaveBeenCalled();
  });

  it("refuses to text a number on the STOP list (recipient_opted_out)", async () => {
    vi.mocked(checkSmsOptOut).mockResolvedValue({ ok: true, optedOut: true });
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { body: "hi" } })
    );
    const body = await res.json();
    expect(body).toEqual({ ok: false, detail: "recipient_opted_out" });
    expect(sendTelnyxSms).not.toHaveBeenCalled();
    expect(checkSmsOptOut).toHaveBeenCalledWith(BIZ, "+15555550100");
  });

  it("fails CLOSED when the opt-out check errors (never 'couldn't check, send anyway')", async () => {
    vi.mocked(checkSmsOptOut).mockResolvedValue({ ok: false, error: "db down" });
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { body: "hi" } })
    );
    const body = await res.json();
    expect(body).toEqual({ ok: false, detail: "opt_out_check_failed" });
    expect(sendTelnyxSms).not.toHaveBeenCalled();
  });
});
