import { describe, expect, it, vi } from "vitest";
import {
  TendlcClient,
  TendlcApiError,
  type TendlcCampaignSubmit
} from "@/lib/telnyx/tendlc";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const SAMPLE_SUBMIT: TendlcCampaignSubmit = {
  brandId: "brand_xyz",
  usecase: "CUSTOMER_CARE",
  description: "AI customer service for SMBs",
  messageFlow: "Customers initiate by texting the published number",
  helpMessage: "Reply HELP for help",
  optoutMessage: "You're opted out.",
  optinMessage: "You're opted in.",
  optinKeywords: "START,YES",
  optoutKeywords: "STOP",
  helpKeywords: "HELP",
  sample1: "Sample 1 — STOP to opt out.",
  sample2: "Sample 2 — STOP to opt out."
};

describe("TendlcClient constructor", () => {
  it("rejects empty/blank apiKey", () => {
    expect(() => new TendlcClient({ apiKey: "" })).toThrow(/apiKey is required/);
    expect(() => new TendlcClient({ apiKey: "   " })).toThrow(/apiKey is required/);
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { campaignId: "c-1", status: "PENDING" })
    );
    const client = new TendlcClient({
      apiKey: "k",
      baseUrl: "https://example.test/v2/",
      fetchImpl
    });
    await client.getCampaign("c-1");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://example.test/v2/10dlc/campaign/c-1");
  });

  it("sets the User-Agent header when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { campaignId: "c-1", status: "PENDING" })
    );
    const client = new TendlcClient({
      apiKey: "k",
      userAgent: "newcoworker-test/1.0",
      fetchImpl
    });
    await client.getCampaign("c-1");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(
      "newcoworker-test/1.0"
    );
  });
});

describe("TendlcClient.createCampaign", () => {
  it("posts to /10dlc/campaignBuilder with the JSON payload + bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          campaignId: "c-1",
          status: "PENDING",
          brandId: "brand_xyz",
          usecase: "CUSTOMER_CARE"
        }
      })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    const c = await client.createCampaign(SAMPLE_SUBMIT);
    expect(c.campaignId).toBe("c-1");
    expect(c.status).toBe("PENDING");
    expect(c.brandId).toBe("brand_xyz");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/10dlc/campaignBuilder");
    const i = init as RequestInit;
    expect(i.method).toBe("POST");
    expect((i.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect((i.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
    expect(JSON.parse(i.body as string)).toEqual(SAMPLE_SUBMIT);
  });

  it("normalizes a top-level (non-{data:…}) campaign response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { campaignId: "c-2", status: "ACTIVE" })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    const c = await client.createCampaign(SAMPLE_SUBMIT);
    expect(c.campaignId).toBe("c-2");
    expect(c.status).toBe("ACTIVE");
  });

  it("falls back to .id when .campaignId is absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "c-3", status: "PENDING" })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    const c = await client.createCampaign(SAMPLE_SUBMIT);
    expect(c.campaignId).toBe("c-3");
  });

  it("throws when the response has neither campaignId nor id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: "PENDING" }));
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    await expect(client.createCampaign(SAMPLE_SUBMIT)).rejects.toThrow(
      /missing campaignId/
    );
  });

  it("throws TendlcApiError on 4xx (insufficient funds, validation, etc)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(402, {
        errors: [{ code: "20100", title: "Insufficient Funds" }]
      })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    try {
      await client.createCampaign(SAMPLE_SUBMIT);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TendlcApiError);
      const e = err as TendlcApiError;
      expect(e.status).toBe(402);
      expect(e.body).toContain("Insufficient Funds");
      expect(e.endpoint).toBe("/10dlc/campaignBuilder");
      expect(e.conflict).toBe(false);
    }
  });

  it("flags 409 as conflict (idempotency hint to caller)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(409, { errors: [{ title: "Already exists" }] })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    try {
      await client.createCampaign(SAMPLE_SUBMIT);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TendlcApiError);
      expect((err as TendlcApiError).conflict).toBe(true);
    }
  });
});

describe("TendlcClient.getCampaign", () => {
  it("rejects empty campaignId", async () => {
    const client = new TendlcClient({ apiKey: "k", fetchImpl: vi.fn() });
    await expect(client.getCampaign("")).rejects.toThrow(/campaignId is required/);
    await expect(client.getCampaign("   ")).rejects.toThrow(/campaignId is required/);
  });

  it("URL-encodes the id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { campaignId: "needs/encoding", status: "ACTIVE" })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    await client.getCampaign("needs/encoding");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.telnyx.com/v2/10dlc/campaign/needs%2Fencoding"
    );
  });
});

describe("TendlcClient.createPhoneNumberCampaign", () => {
  it("posts the {phoneNumber, campaignId} pair", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: { phoneNumber: "+15551234567", campaignId: "c-1", status: "ACTIVE" }
      })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    const r = await client.createPhoneNumberCampaign({
      phoneNumber: "+15551234567",
      campaignId: "c-1"
    });
    expect(r).toMatchObject({
      phoneNumber: "+15551234567",
      campaignId: "c-1",
      status: "ACTIVE"
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/10dlc/phoneNumberCampaign");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ phoneNumber: "+15551234567", campaignId: "c-1" });
  });

  it("normalizes snake_case fields if Telnyx returns them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { phone_number: "+15551234567", campaign_id: "c-1" })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    const r = await client.createPhoneNumberCampaign({
      phoneNumber: "+15551234567",
      campaignId: "c-1"
    });
    expect(r.phoneNumber).toBe("+15551234567");
    expect(r.campaignId).toBe("c-1");
  });

  it("throws when the response is missing phoneNumber/campaignId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: "ACTIVE" }));
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    await expect(
      client.createPhoneNumberCampaign({
        phoneNumber: "+15551234567",
        campaignId: "c-1"
      })
    ).rejects.toThrow(/missing phoneNumber\/campaignId/);
  });
});

describe("TendlcClient.getPhoneNumberCampaign", () => {
  it("URL-encodes the E.164 number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { phoneNumber: "+15551234567", campaignId: "c-1" })
    );
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    await client.getPhoneNumberCampaign("+15551234567");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.telnyx.com/v2/10dlc/phoneNumberCampaign/%2B15551234567"
    );
  });

  it("returns null on 404 (no attachment exists yet)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { errors: [] }));
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    const r = await client.getPhoneNumberCampaign("+15551234567");
    expect(r).toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { errors: [] }));
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    await expect(client.getPhoneNumberCampaign("+15551234567")).rejects.toBeInstanceOf(
      TendlcApiError
    );
  });

  it("rethrows non-Telnyx errors (network/abort)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    await expect(client.getPhoneNumberCampaign("+15551234567")).rejects.toThrow(
      /fetch failed/
    );
  });
});

describe("TendlcClient.deletePhoneNumberCampaign", () => {
  it("DELETEs the encoded resource and tolerates 204 with no body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    await client.deletePhoneNumberCampaign("+15551234567");
    const [url, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).method).toBe("DELETE");
    expect(url).toBe(
      "https://api.telnyx.com/v2/10dlc/phoneNumberCampaign/%2B15551234567"
    );
  });

  it("tolerates a 200 with empty body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 200 }));
    const client = new TendlcClient({ apiKey: "k", fetchImpl });
    await expect(
      client.deletePhoneNumberCampaign("+15551234567")
    ).resolves.toBeUndefined();
  });
});

describe("TendlcApiError", () => {
  it("truncates very long bodies in the message but keeps full body on the field", () => {
    const big = "x".repeat(2000);
    const err = new TendlcApiError("/x", 422, big);
    expect(err.message.length).toBeLessThan(big.length + 100);
    expect(err.body.length).toBe(2000);
    expect(err.endpoint).toBe("/x");
    expect(err.status).toBe(422);
    expect(err.conflict).toBe(false);
  });
});
