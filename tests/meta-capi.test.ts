/**
 * Meta Conversions API (Conversion Leads) upload client
 * (src/lib/meta/capi.ts): payload building — identifier precedence,
 * hashing, the big-integer lead_id inlining — and the /events POST.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  CAPI_LEAD_EVENT_SOURCE,
  buildConversionLeadBody,
  hashedEmail,
  hashedPhone,
  sendConversionLeadBody,
  sha256Hex
} from "@/lib/meta/capi";
import { MetaApiError } from "@/lib/meta/client";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hashing helpers", () => {
  it("hashes normalized email (trim + lowercase) and phone (digits only)", () => {
    expect(hashedEmail("  Jane@Example.com ")).toBe(sha256Hex("jane@example.com"));
    expect(hashedPhone("+1 (602) 555-1234")).toBe(sha256Hex("16025551234"));
  });

  it("rejects empty email and too-short phones", () => {
    expect(hashedEmail("   ")).toBeNull();
    expect(hashedPhone("12345")).toBeNull();
  });
});

describe("buildConversionLeadBody", () => {
  const base = {
    eventName: "Booked",
    eventTimeMs: 1786_000_000_500,
    eventId: "ce:tag:+16025551234:booked:added:123"
  };

  it("inlines a 17-digit lead_id as a bare number (no precision loss)", () => {
    // 17 digits — exceeds Number.MAX_SAFE_INTEGER; a JS-number build would
    // corrupt the trailing digits.
    const body = buildConversionLeadBody({ ...base, leadgenId: "12345678901234567" })!;
    expect(body).toContain('"lead_id":12345678901234567');
    expect(body).not.toContain("__LEAD_ID__");
    const parsed = JSON.parse(body) as {
      data: Array<Record<string, unknown>>;
    };
    const event = parsed.data[0];
    expect(event.event_name).toBe("Booked");
    expect(event.event_time).toBe(Math.floor(base.eventTimeMs / 1000));
    expect(event.event_id).toBe(base.eventId);
    expect(event.action_source).toBe("system_generated");
    expect(event.custom_data).toEqual({
      lead_event_source: CAPI_LEAD_EVENT_SOURCE,
      event_source: "crm"
    });
  });

  it("accepts an l:-prefixed leadgen id and adds hashed identifiers alongside", () => {
    const body = buildConversionLeadBody({
      ...base,
      leadgenId: "l:1993202861289031",
      email: "Jane@Example.com",
      phoneE164: "+16025551234"
    })!;
    expect(body).toContain('"lead_id":1993202861289031');
    const userData = (JSON.parse(body) as { data: Array<{ user_data: Record<string, unknown> }> })
      .data[0].user_data;
    expect(userData.em).toEqual([sha256Hex("jane@example.com")]);
    expect(userData.ph).toEqual([sha256Hex("16025551234")]);
  });

  it("falls back to hashed email/phone when the leadgen id is unusable", () => {
    const body = buildConversionLeadBody({
      ...base,
      leadgenId: "not-a-lead-id",
      email: "jane@example.com"
    })!;
    const userData = (JSON.parse(body) as { data: Array<{ user_data: Record<string, unknown> }> })
      .data[0].user_data;
    expect(userData).toEqual({ em: [sha256Hex("jane@example.com")] });

    const phoneOnly = buildConversionLeadBody({ ...base, phoneE164: "+16025551234" })!;
    const phData = (JSON.parse(phoneOnly) as {
      data: Array<{ user_data: Record<string, unknown> }>;
    }).data[0].user_data;
    expect(phData).toEqual({ ph: [sha256Hex("16025551234")] });
  });

  it("returns null when the event has no usable identifier (Meta would reject it)", () => {
    expect(buildConversionLeadBody(base)).toBeNull();
    expect(
      buildConversionLeadBody({ ...base, leadgenId: "abc", email: " ", phoneE164: "123" })
    ).toBeNull();
  });

  it("bounds event_name and event_id lengths", () => {
    const body = buildConversionLeadBody({
      ...base,
      eventName: "x".repeat(300),
      eventId: "y".repeat(300),
      leadgenId: "1993202861289031"
    })!;
    const event = (JSON.parse(body) as { data: Array<Record<string, unknown>> }).data[0];
    expect((event.event_name as string).length).toBe(100);
    expect((event.event_id as string).length).toBe(100);
  });
});

describe("sendConversionLeadBody", () => {
  const BODY = '{"data":[]}';

  it("POSTs the raw body to the dataset's /events edge with the token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { events_received: 1 }));
    const res = await sendConversionLeadBody("ds-1", "tok", BODY);
    expect(res).toEqual({ eventsReceived: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v25.0/ds-1/events");
    expect(parsed.searchParams.get("access_token")).toBe("tok");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(BODY);
  });

  it("tolerates a response without events_received or with non-JSON", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    expect(await sendConversionLeadBody("ds-1", "tok", BODY)).toEqual({
      eventsReceived: null
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "ok"
    } as unknown as Response);
    expect(await sendConversionLeadBody("ds-1", "tok", BODY)).toEqual({
      eventsReceived: null
    });
  });

  it("throws a typed error on refusal, timeout, and network failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: "bad lead_id" } }));
    await expect(sendConversionLeadBody("ds-1", "tok", BODY)).rejects.toMatchObject({
      name: "MetaApiError",
      code: "request_failed",
      status: 400
    });

    // A failed error-body read must not mask the refusal.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("stream gone");
      }
    } as unknown as Response);
    await expect(sendConversionLeadBody("ds-1", "tok", BODY)).rejects.toBeInstanceOf(
      MetaApiError
    );

    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(sendConversionLeadBody("ds-1", "tok", BODY)).rejects.toMatchObject({
      code: "upstream_timeout"
    });

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(sendConversionLeadBody("ds-1", "tok", BODY)).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });

  it("aborts a hung upload after the request budget (real timer firing)", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      );
      const pending = sendConversionLeadBody("ds-1", "tok", BODY);
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sha256Hex", () => {
  it("matches node crypto directly", () => {
    expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});
