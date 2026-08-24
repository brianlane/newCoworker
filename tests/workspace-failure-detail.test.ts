import { describe, expect, it } from "vitest";

import { providerFailureDetail } from "@/lib/workspace/failure-detail";
import {
  DirectTransportError,
  DirectTransportUnreachable
} from "@/lib/workspace/direct-transport";

/**
 * What a failed provider call leaves behind in system_logs.
 *
 * Two incidents set the bar. The 2026-08-08 row read "Request failed with
 * status code 400" with an empty payload: a call failed somewhere, and nothing
 * more. Gmail puts the actual reason in the response body, so a repeat is only
 * actionable if the body came with it. The 2026-08-22 row read "Provider
 * request timed out" with only a connection id, and a response-less transport
 * failure has no status or body at all, so `code` is the only thing that can
 * separate a 20-second abort from a DNS failure.
 */
describe("providerFailureDetail", () => {
  it("keeps the status, endpoint and response body from an axios rejection", () => {
    const detail = providerFailureDetail({
      response: { status: 400, data: { error: { message: "Invalid query" } } },
      config: { endpoint: "/gmail/v1/users/me/messages?q=newer_than:1h" }
    });
    expect(detail.status).toBe(400);
    expect(detail.endpoint).toContain("/gmail/v1/users/me/messages");
    expect(String(detail.response)).toContain("Invalid query");
  });

  it("falls back to the top-level status and the url field", () => {
    const detail = providerFailureDetail({ status: 503, config: { url: "/x" } });
    expect(detail).toEqual({ status: 503, endpoint: "/x" });
  });

  it("returns an empty object for a throw it does not recognise", () => {
    expect(providerFailureDetail(new Error("boom"))).toEqual({});
    expect(providerFailureDetail("string boom")).toEqual({});
    expect(providerFailureDetail(null)).toEqual({});
    expect(providerFailureDetail(undefined)).toEqual({});
  });

  it("keeps a string body as-is and clips a long one", () => {
    const detail = providerFailureDetail({ response: { status: 500, data: "x".repeat(900) } });
    expect(String(detail.response)).toHaveLength(500);
  });

  it("survives a body that cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const detail = providerFailureDetail({ response: { status: 400, data: circular } });
    expect(detail.status).toBe(400);
    expect(typeof detail.response).toBe("string");
  });

  it("ignores an empty endpoint and a null body rather than recording blanks", () => {
    expect(providerFailureDetail({ config: { url: "" }, response: { data: null } })).toEqual({});
  });

  // The 2026-08-22 case, end to end: this is the real throw the AiFlow email
  // poll caught, and the payload it should have carried.
  it("records the transport code of a response-less timeout", () => {
    const err = new DirectTransportUnreachable("upstream_timeout", "Provider request timed out");
    expect(providerFailureDetail(err)).toEqual({ code: "upstream_timeout" });
  });

  it("records the transport code of a response-less unreachable", () => {
    const err = new DirectTransportUnreachable("upstream_unreachable", "Provider unreachable");
    expect(providerFailureDetail(err)).toEqual({ code: "upstream_unreachable" });
  });

  it("drops request_failed, which says nothing the status does not say better", () => {
    // DirectTransportError defaults to code "request_failed" and carries a real
    // status; recording both would just be noise next to the status.
    const err = new DirectTransportError(429, { error: "rateLimitExceeded" });
    const detail = providerFailureDetail(err);
    expect(detail.code).toBeUndefined();
    expect(detail.status).toBe(429);
    expect(String(detail.response)).toContain("rateLimitExceeded");
  });

  it("ignores a Node system error code it was not taught", () => {
    // Node hangs ECONNRESET and friends on `code`; the direct transport already
    // normalises those into upstream_unreachable, so an unrecognised one here
    // is not a transport code and must not be recorded as if it were.
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(providerFailureDetail(err)).toEqual({});
  });
});
