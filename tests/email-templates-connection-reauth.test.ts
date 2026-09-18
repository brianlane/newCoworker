/**
 * Owner-facing reconnect email for every stored grant except Calendly.
 */
import { describe, expect, it } from "vitest";
import { buildConnectionReauthEmail } from "@/lib/email/templates/connection-reauth";
import { connectionPausedWork } from "@/lib/connections/reauth-copy";
import es from "../messages/es.json";

const CONN = "aaaaaaaa-1111-4111-8111-111111111111";

describe("buildConnectionReauthEmail", () => {
  it("names Zoom and the account, says meetings are paused, deep-links Reconnect", () => {
    const copy = buildConnectionReauthEmail({
      provider: "Zoom",
      accountLabel: "Acme Zoom",
      connectionId: CONN,
      slug: "zoom",
      pausedWork: connectionPausedWork("Zoom"),
      lastHealthyLabel: "Sep 16, 2026, 5:01 AM"
    });
    expect(copy.subject).toBe("Zoom needs to be reconnected");
    expect(copy.heading).toBe("Zoom needs to be reconnected");
    expect(copy.body).toContain("Acme Zoom");
    expect(copy.body).toContain("Zoom");
    expect(copy.body).toContain("Meetings and transcripts");
    expect(copy.body).toContain("paused");
    expect(copy.body).toContain("Sep 16, 2026, 5:01 AM");
    expect(copy.body).toContain("not backfilled");
    expect(copy.body.toLowerCase()).not.toContain("token rejected");
    expect(copy.body.toLowerCase()).not.toContain("invalid_grant");
    expect(copy.ctaLabel).toBe("Reconnect Zoom");
    expect(copy.ctaPath).toBe(`/dashboard/integrations/zoom?reconnect=${CONN}`);
    expect(copy.summaryLine).toContain("Acme Zoom");
    expect(copy.smsBody).toContain("Acme Zoom");
  });

  it("names Google and the mailbox, omits last-check when never stamped", () => {
    const copy = buildConnectionReauthEmail({
      provider: "Google",
      accountLabel: "james@kyp.test",
      connectionId: CONN,
      slug: "google",
      pausedWork: connectionPausedWork("Google"),
      lastHealthyLabel: null
    });
    expect(copy.subject).toBe("Google needs to be reconnected");
    expect(copy.body).toContain("james@kyp.test");
    expect(copy.body).toContain("Mail and calendar");
    expect(copy.body).not.toContain("last successful check");
    expect(copy.ctaPath).toContain("/dashboard/integrations/google");
  });

  it("renders the Spanish catalog when asked", () => {
    const copy = buildConnectionReauthEmail({
      provider: "Zoom",
      accountLabel: "Acme Zoom",
      connectionId: CONN,
      slug: "zoom",
      pausedWork: connectionPausedWork("Zoom"),
      lastHealthyLabel: "16 sept 2026",
      locale: "es"
    });
    expect(copy.subject).toContain("Zoom");
    expect(copy.subject).toBe(
      es.emails.connectionReauth.subject.replace("{provider}", "Zoom")
    );
    expect(copy.body).toContain("Acme Zoom");
  });
});
