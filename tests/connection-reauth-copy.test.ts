/**
 * Shared reconnect copy: provider + account, never "token rejected".
 */
import { describe, expect, it } from "vitest";
import {
  connectionAccountLabel,
  connectionPausedUntilCopy,
  connectionPausedWork,
  connectionReauthBannerBody,
  connectionReconnectPath,
  formatConnectionLastHealthy,
  isSlackTokenDead,
  isPermanentConnectionAuthError,
  withReauthColumnDefaults,
  workspaceIntegrationsSlug,
  workspaceProviderLabel
} from "@/lib/connections/reauth-copy";

describe("workspaceProviderLabel", () => {
  it("maps Google and Microsoft keys, and nothing else, to the owner-facing name", () => {
    expect(workspaceProviderLabel("google")).toBe("Google");
    expect(workspaceProviderLabel("gmail")).toBe("Google");
    expect(workspaceProviderLabel("google-calendar")).toBe("Google");
    expect(workspaceProviderLabel("outlook")).toBe("Microsoft 365");
    expect(workspaceProviderLabel("outlook-calendar")).toBe("Microsoft 365");
    expect(workspaceIntegrationsSlug("google")).toBe("google");
    expect(workspaceIntegrationsSlug("outlook")).toBe("microsoft");
    expect(workspaceProviderLabel("salesforce")).toBe("Workspace");
    expect(workspaceIntegrationsSlug("salesforce")).toBe("workspace");
  });
});

describe("connectionAccountLabel", () => {
  it("prefers the name the owner already knows the account by", () => {
    expect(
      connectionAccountLabel("Zoom", { account_name: "Acme Zoom", account_email: "z@a.test" })
    ).toBe("Acme Zoom");
    expect(connectionAccountLabel("Google", { account_email: "james@kyp.test" })).toBe(
      "james@kyp.test"
    );
    expect(connectionAccountLabel("Slack", { team_name: "KYP" })).toBe("KYP");
    expect(connectionAccountLabel("Facebook", { page_name: "KYP Ads" })).toBe("KYP Ads");
    expect(connectionAccountLabel("WhatsApp", { display_phone_number: "+1 555-0100" })).toBe(
      "+1 555-0100"
    );
    expect(connectionAccountLabel("CalDAV", { username: "james@icloud.com" })).toBe(
      "james@icloud.com"
    );
    expect(
      connectionAccountLabel("Google", {
        metadata: { provider_account_display_name: "James Lee" }
      })
    ).toBe("James Lee");
    expect(connectionAccountLabel("Zoom", {})).toBe("Zoom");
  });
});

describe("connectionReauthBannerBody", () => {
  it("names provider and account, says work is paused, never says token rejected", () => {
    const body = connectionReauthBannerBody({
      provider: "Zoom",
      accountLabel: "Acme Zoom",
      lastHealthyLabel: "Sep 16, 2026, 5:01 AM"
    });
    expect(body).toContain("Acme Zoom");
    expect(body).toContain("Zoom");
    expect(body).toContain("Meetings and transcripts");
    expect(body).toContain("paused");
    expect(body).toContain("Sep 16, 2026, 5:01 AM");
    expect(body.toLowerCase()).not.toContain("token rejected");
    expect(body.toLowerCase()).not.toContain("invalid_grant");
  });

  it("omits last-check when we have never stamped one", () => {
    const body = connectionReauthBannerBody({
      provider: "Google",
      accountLabel: "James Lee",
      lastHealthyLabel: null
    });
    expect(body).not.toContain("last successful check");
    expect(body).toContain("James Lee");
    expect(body).toContain("Mail and calendar");
  });
});

describe("connectionPausedUntilCopy", () => {
  it("is the flow-pause sentence, provider named", () => {
    expect(connectionPausedUntilCopy("Acuity")).toBe("Paused until Acuity is reconnected.");
    expect(connectionPausedWork("WhatsApp")).toContain("WhatsApp messages");
  });
});

describe("connectionReconnectPath", () => {
  it("deep-links Reconnect on that same row", () => {
    expect(connectionReconnectPath("zoom", "aaaaaaaa-1111-4111-8111-111111111111")).toBe(
      "/dashboard/integrations/zoom?reconnect=aaaaaaaa-1111-4111-8111-111111111111"
    );
  });
});

describe("formatConnectionLastHealthy", () => {
  it("returns null for missing or unusable stamps", () => {
    expect(formatConnectionLastHealthy(null)).toBeNull();
    expect(formatConnectionLastHealthy("not-a-date")).toBeNull();
    expect(formatConnectionLastHealthy("2026-09-16T12:01:00.000Z")).toContain("2026");
  });
});

describe("isSlackTokenDead", () => {
  it("matches Slack's dead-token errors and nothing else", () => {
    expect(isSlackTokenDead("invalid_auth")).toBe(true);
    expect(isSlackTokenDead("token_revoked")).toBe(true);
    expect(isSlackTokenDead("account_inactive")).toBe(true);
    expect(isSlackTokenDead("token_expired")).toBe(true);
    expect(isSlackTokenDead("channel_not_found")).toBe(false);
    expect(isSlackTokenDead("not_in_channel")).toBe(false);
    expect(isSlackTokenDead(null)).toBe(false);
  });
});

describe("isPermanentConnectionAuthError", () => {
  it("matches 4xx auth_failed and refuses 5xx", () => {
    expect(isPermanentConnectionAuthError({ code: "auth_failed", status: 401 })).toBe(true);
    expect(isPermanentConnectionAuthError({ code: "auth_failed", status: 403 })).toBe(true);
    expect(isPermanentConnectionAuthError({ code: "auth_failed" })).toBe(true);
    expect(isPermanentConnectionAuthError({ code: "auth_failed", status: 503 })).toBe(false);
    expect(isPermanentConnectionAuthError({ code: "request_failed", status: 401 })).toBe(false);
    expect(isPermanentConnectionAuthError(new Error("boom"))).toBe(false);
    expect(isPermanentConnectionAuthError(null)).toBe(false);
    expect(isPermanentConnectionAuthError("auth_failed")).toBe(false);
  });
});

describe("withReauthColumnDefaults", () => {
  it("coerces missing columns so a pre-migration row does not look flagged", () => {
    expect(withReauthColumnDefaults({ id: "x" })).toEqual({
      id: "x",
      needs_reauth: false,
      last_healthy_at: null,
      reauth_email_count: 0,
      reauth_email_last_sent_at: null
    });
    expect(
      withReauthColumnDefaults({
        needs_reauth: true,
        last_healthy_at: "2026-09-16T12:01:00.000Z",
        reauth_email_count: 2,
        reauth_email_last_sent_at: "2026-09-17T02:11:00.000Z"
      })
    ).toMatchObject({
      needs_reauth: true,
      last_healthy_at: "2026-09-16T12:01:00.000Z",
      reauth_email_count: 2
    });
  });
});

describe("connectionPausedWork", () => {
  it("names the paused work per provider", () => {
    expect(connectionPausedWork("Google")).toContain("Mail and calendar");
    expect(connectionPausedWork("Microsoft 365")).toContain("Mail and calendar");
    expect(connectionPausedWork("Workspace")).toContain("Mail and calendar");
    expect(connectionPausedWork("Zoom")).toContain("Meetings");
    expect(connectionPausedWork("Acuity")).toContain("Calendar follow-ups");
    expect(connectionPausedWork("Vagaro")).toContain("Calendar follow-ups");
    expect(connectionPausedWork("CalDAV")).toContain("Calendar booking");
    expect(connectionPausedWork("Facebook")).toContain("Lead forms");
    expect(connectionPausedWork("Slack")).toContain("Slack alerts");
    expect(connectionPausedWork("WhatsApp")).toContain("WhatsApp messages");
  });
});
