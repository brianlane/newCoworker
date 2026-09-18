/**
 * Owner-facing Calendly reconnect email
 * (src/lib/email/templates/calendly-reauth.ts).
 *
 * The copy has to tell the owner which account, that follow-ups are paused,
 * and where to click. It must never say "token rejected".
 */
import { describe, expect, it } from "vitest";
import { buildCalendlyReauthEmail } from "@/lib/email/templates/calendly-reauth";
import es from "../messages/es.json";

const CONN = "aaaaaaaa-1111-4111-8111-111111111111";

describe("buildCalendlyReauthEmail", () => {
  it("names the account, says follow-ups are paused, and deep-links Reconnect", () => {
    const copy = buildCalendlyReauthEmail({
      accountLabel: "James Lee",
      connectionId: CONN,
      lastHealthyLabel: "Sep 16, 2026, 5:01 AM"
    });
    expect(copy.subject).toBe("Calendly needs a reconnect");
    expect(copy.heading).toBe("Calendly needs a reconnect");
    expect(copy.body).toContain("James Lee");
    expect(copy.body).toContain("Calendar follow-ups");
    expect(copy.body).toContain("booking checks");
    expect(copy.body).toContain("paused");
    expect(copy.body).toContain("Sep 16, 2026, 5:01 AM");
    expect(copy.body.toLowerCase()).not.toContain("token rejected");
    expect(copy.body.toLowerCase()).not.toContain("invalid_grant");
    expect(copy.ctaLabel).toBe("Reconnect Calendly");
    expect(copy.ctaPath).toBe(`/dashboard/integrations/calendly?reconnect=${CONN}`);
    expect(copy.summaryLine).toContain("James Lee");
    expect(copy.smsBody).toContain("James Lee");
    expect(copy.body.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  it("omits the last-check line when we have never stamped one", () => {
    const copy = buildCalendlyReauthEmail({
      accountLabel: "Liz Stone",
      connectionId: CONN,
      lastHealthyLabel: null
    });
    expect(copy.body).not.toContain("last successful check");
    expect(copy.body).toContain("Liz Stone");
  });

  it("renders the Spanish catalog when asked", () => {
    const copy = buildCalendlyReauthEmail({
      accountLabel: "James Lee",
      connectionId: CONN,
      lastHealthyLabel: "16 sept 2026",
      locale: "es"
    });
    expect(copy.subject).toBe(es.emails.calendlyReauth.subject);
    expect(copy.body).toContain("James Lee");
    expect(copy.ctaLabel).toBe(es.emails.calendlyReauth.cta);
  });
});
