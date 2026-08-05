import { describe, expect, it } from "vitest";
import { recipientWasUnmatched } from "../cloudflare/email-worker/src/unmatched";

/**
 * The worker forwards a message to a human ONLY when this returns true, so the
 * two ways to be wrong are not symmetric:
 *
 *  - a false negative loses a stray email, which is exactly today's behavior
 *  - a false positive forwards a TENANT's customer mail to the operator's
 *    personal inbox, which is a privacy incident
 *
 * So anything ambiguous, malformed, or unrecognized must answer false.
 */
describe("recipientWasUnmatched", () => {
  it("is true for the app's unmatched envelope", () => {
    expect(recipientWasUnmatched({ ok: true, data: { matched: false } })).toBe(true);
  });

  it("is false when a tenant took the message", () => {
    expect(
      recipientWasUnmatched({ ok: true, data: { matched: true, businessId: "b1", enqueued: 2 } })
    ).toBe(false);
  });

  it("is false for an error envelope, even one that mentions matched", () => {
    expect(
      recipientWasUnmatched({ ok: false, error: { code: "DB_ERROR", message: "matched" } })
    ).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "matched: false"],
    ["a number", 0],
    ["an array", []],
    ["an empty object", {}],
    ["ok without data", { ok: true }],
    ["data that is not an object", { ok: true, data: "false" }],
    ["data without matched", { ok: true, data: { enqueued: 0 } }],
    ["matched as the string 'false'", { ok: true, data: { matched: "false" } }],
    ["matched null", { ok: true, data: { matched: null } }],
    ["ok missing entirely", { data: { matched: false } }],
    ["ok as the string 'true'", { ok: "true", data: { matched: false } }]
  ])("is false for %s", (_label, body) => {
    expect(recipientWasUnmatched(body)).toBe(false);
  });
});
