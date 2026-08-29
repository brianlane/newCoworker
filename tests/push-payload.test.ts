import { describe, expect, it } from "vitest";
import { buildPushPayload } from "@/lib/push/payload";

/**
 * The real ceiling is module-private, so this restates the budget rather than
 * importing it. That is deliberate: an export only a test calls is dead code
 * wearing coverage, and asserting against the module's own constant would
 * pass even if that constant were raised past what RFC 8291 allows.
 */
const MAX_PAYLOAD_BYTES = 3800;

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

describe("push/payload: buildPushPayload", () => {
  it("carries the fields the service worker reads", () => {
    const parsed = JSON.parse(
      buildPushPayload({
        title: "New lead",
        body: "Sarah Chen, +1 415 555 0142",
        url: "/dashboard/messages/+14155550142",
        notificationId: "11111111-1111-1111-1111-111111111111",
        tag: "contact:+14155550142"
      })
    );
    expect(parsed).toEqual({
      title: "New lead",
      body: "Sarah Chen, +1 415 555 0142",
      url: "/dashboard/messages/+14155550142",
      notificationId: "11111111-1111-1111-1111-111111111111",
      tag: "contact:+14155550142"
    });
  });

  it("omits the optional fields entirely when they are absent", () => {
    const parsed = JSON.parse(buildPushPayload({ title: "T", body: "B", url: "/dashboard" }));
    expect(Object.keys(parsed).sort()).toEqual(["body", "title", "url"]);
  });

  it("falls back to a usable title rather than shipping an empty one", () => {
    const parsed = JSON.parse(buildPushPayload({ title: "   ", body: "B", url: "/dashboard" }));
    expect(parsed.title).toBe("New Coworker");
  });

  /**
   * RFC 8291 caps an encrypted push record at 4096 bytes and the push service
   * answers 413 over it. A 413 is our bug, not the browser's, so the clamp is
   * the thing that keeps it from ever happening.
   */
  it("stays under the byte ceiling for an enormous body", () => {
    const payload = buildPushPayload({
      title: "Alert",
      body: "x".repeat(20_000),
      url: "/dashboard"
    });
    expect(bytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  /**
   * Budgeting by `.length` instead of encoded bytes passes a Latin test and
   * overflows in production the first time an owner's alert names someone in
   * Japanese or uses an emoji.
   */
  it("stays under the ceiling for multi-byte text", () => {
    const payload = buildPushPayload({
      title: "警告",
      body: "顧客からの新しいメッセージです。".repeat(1000),
      url: "/dashboard"
    });
    expect(bytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("stays under the ceiling for text that JSON escaping expands", () => {
    // A quote and a backslash each double under JSON.stringify, so a budget
    // measured on the raw string overflows the encoded one.
    const payload = buildPushPayload({
      title: "Alert",
      body: '"\\'.repeat(4000),
      url: "/dashboard"
    });
    expect(bytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("never splits a multi-byte character when it truncates", () => {
    const payload = buildPushPayload({
      title: "Alert",
      body: "🚨".repeat(5000),
      url: "/dashboard"
    });
    const parsed = JSON.parse(payload);
    // A lone surrogate would survive the round trip as U+FFFD.
    expect(parsed.body).not.toContain("�");
    expect(bytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("marks a clamped body so it does not read as the whole alert", () => {
    const parsed = JSON.parse(
      buildPushPayload({ title: "Alert", body: "x".repeat(20_000), url: "/dashboard" })
    );
    expect(parsed.body.endsWith("...")).toBe(true);
  });

  it("leaves a short body untouched", () => {
    const parsed = JSON.parse(buildPushPayload({ title: "T", body: "short", url: "/dashboard" }));
    expect(parsed.body).toBe("short");
  });

  /**
   * The worker hands `url` to clients.openWindow, so an absolute or
   * protocol-relative value would let a notification navigate the owner
   * off-site. Same rule notificationLink applies in display.ts.
   */
  it.each([
    ["absolute", "https://evil.example.com/steal"],
    ["protocol-relative", "//evil.example.com/steal"],
    ["scheme-only", "javascript:alert(1)"],
    ["relative without a slash", "dashboard"]
  ])("refuses an off-site %s tap target", (_name, url) => {
    expect(JSON.parse(buildPushPayload({ title: "T", body: "B", url })).url).toBe("/dashboard");
  });

  it("keeps a legitimate internal path", () => {
    expect(
      JSON.parse(buildPushPayload({ title: "T", body: "B", url: "/dashboard/calls/42" })).url
    ).toBe("/dashboard/calls/42");
  });

  it("clamps an over-long title without eating the whole budget", () => {
    const parsed = JSON.parse(
      buildPushPayload({ title: "T".repeat(500), body: "body text", url: "/dashboard" })
    );
    expect(bytes(parsed.title)).toBeLessThanOrEqual(120);
    // The body still survives: a truncated title reads as broken, a truncated
    // body reads as a summary, so the title is what gets cut first.
    expect(parsed.body).toBe("body text");
  });

  it("clamps an over-long tag", () => {
    const parsed = JSON.parse(
      buildPushPayload({ title: "T", body: "B", url: "/dashboard", tag: "t".repeat(200) })
    );
    expect(bytes(parsed.tag)).toBeLessThanOrEqual(64);
  });
});
