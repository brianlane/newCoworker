/**
 * The send-as alias rule (src/lib/outreach/send-as.ts), shared by the
 * dashboard save and the HQ one-shot, and mirrored by the DB check
 * `outreach_settings_send_as_email_shape`. The three have to agree on what
 * counts as one address, so the cases here are the cases the SQL regex has to
 * accept and refuse too.
 */
import { describe, expect, it } from "vitest";
import { normalizeSendAsEmail, SEND_AS_EMAIL_SHAPE } from "@/lib/outreach/send-as";

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

  it("is the same shape the migration's check constraint enforces", () => {
    // The SQL regex is a POSIX rendering of this one; keeping the JS source
    // pinned here makes a drift between the two a visible diff in review.
    expect(SEND_AS_EMAIL_SHAPE.source).toBe('^[^\\s@<>,;"]+@[^\\s@<>,;"]+\\.[^\\s@<>,;"]+$');
  });
});
