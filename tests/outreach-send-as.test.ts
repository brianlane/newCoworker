/**
 * The send-as alias rule (src/lib/outreach/send-as.ts), shared by the
 * dashboard save and the HQ one-shot, and mirrored by the DB check
 * `outreach_settings_send_as_email_shape`. The three have to agree on what
 * counts as one address, so the cases here are the cases the SQL regex has to
 * accept and refuse too; tests/worker-integration/outreach-send-as-column.itest.ts
 * runs the refusals against the real constraint.
 */
import { describe, expect, it } from "vitest";
import { normalizeSendAsEmail } from "@/lib/outreach/send-as";

describe("normalizeSendAsEmail", () => {
  it("lowercases and trims one address", () => {
    expect(normalizeSendAsEmail("  Team@Acme.TEST ")).toBe("team@acme.test");
    expect(normalizeSendAsEmail("first.last+tag@sub.acme.co.uk")).toBe(
      "first.last+tag@sub.acme.co.uk"
    );
  });

  it("returns null for blank, which means the provider default", () => {
    expect(normalizeSendAsEmail("")).toBeNull();
    expect(normalizeSendAsEmail("   ")).toBeNull();
  });

  it("refuses a display name, a list, or a bare host", () => {
    // Each of these would be written into a From header verbatim and either
    // corrupt it or name two senders.
    for (const bad of [
      "Brian <team@acme.test>",
      "team@acme.test, sales@acme.test",
      "team@acme.test; sales@acme.test",
      "team@acme",
      "@acme.test",
      "team@",
      "team acme@acme.test",
      '"team"@acme.test'
    ]) {
      expect(normalizeSendAsEmail(bad), bad).toBe("invalid");
    }
  });
});
