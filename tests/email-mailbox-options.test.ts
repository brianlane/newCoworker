import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({
  isEmailProviderConfigKey: (key: string) => ["google-mail", "gmail", "outlook"].includes(key),
  providerFromKey: (key: string) =>
    key === "outlook" ? "microsoft" : "google"
}));

vi.mock("@/lib/email/tenant-mailbox", () => ({
  getTenantMailbox: vi.fn(),
  tenantMailboxAddress: (localPart: string) => `${localPart}@newcoworker.com`
}));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn()
}));

import {
  connectionEmail,
  listOutreachSendFromOptions,
  listSendFromOptions
} from "@/lib/email/mailbox-options";
import { getTenantMailbox } from "@/lib/email/tenant-mailbox";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";

const BIZ = "ABCD1234-1111-4111-8111-111111111111";

function conn(over: Partial<{ id: string; provider_config_key: string; metadata: Record<string, unknown> }>) {
  return {
    id: over.id ?? "c1",
    business_id: BIZ,
    provider_config_key: over.provider_config_key ?? "gmail",
    connection_id: "cx",
    metadata: over.metadata ?? {},
    transport: "nango" as const,
    is_active: true,
    oauth_scope: null,
    created_at: "",
    updated_at: ""
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("connectionEmail", () => {
  it("prefers provider_account_email (the real account) over everything", () => {
    expect(
      connectionEmail({
        provider_account_email: "real@gmail.com",
        email: "a@x.com",
        end_user_email: "login@dashboard.com"
      })
    ).toBe("real@gmail.com");
  });
  it("prefers `email` over end_user keys", () => {
    expect(connectionEmail({ email: "a@x.com", end_user_email: "b@x.com" })).toBe("a@x.com");
  });
  it("falls back to end_user_email then end_user_display_name", () => {
    expect(connectionEmail({ end_user_email: "b@x.com" })).toBe("b@x.com");
    expect(connectionEmail({ end_user_display_name: "c@x.com" })).toBe("c@x.com");
  });
  it("prefers a probed display name over the end_user (login) keys", () => {
    expect(
      connectionEmail({
        provider_account_display_name: "Real Owner",
        end_user_email: "login@dashboard.com"
      })
    ).toBe("Real Owner");
  });
  it("returns null when nothing usable is present", () => {
    expect(connectionEmail({})).toBeNull();
    expect(connectionEmail(undefined as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe("listSendFromOptions", () => {
  it("lists the coworker mailbox first, then email connections, skipping non-email", async () => {
    vi.mocked(getTenantMailbox).mockResolvedValue({
      business_id: BIZ,
      local_part: "amy",
      personalized: true,
      created_at: "",
      updated_at: ""
    });
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      conn({ id: "g1", provider_config_key: "gmail", metadata: { email: "amy@gmail.com" } }),
      conn({ id: "o1", provider_config_key: "outlook", metadata: {} }),
      conn({ id: "cal", provider_config_key: "google-calendar", metadata: {} })
    ]);

    await expect(listSendFromOptions(BIZ)).resolves.toEqual([
      { id: "", label: "AI coworker: amy@newcoworker.com", email: "amy@newcoworker.com" },
      { id: "g1", label: "Gmail: amy@gmail.com", email: "amy@gmail.com" },
      { id: "o1", label: "Outlook", email: null }
    ]);
  });

  it("derives the coworker address from the business id when no mailbox is reserved", async () => {
    vi.mocked(getTenantMailbox).mockResolvedValue(null);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([]);

    await expect(listSendFromOptions(BIZ)).resolves.toEqual([
      {
        id: "",
        label: `AI coworker: ${BIZ.toLowerCase()}@newcoworker.com`,
        email: `${BIZ.toLowerCase()}@newcoworker.com`
      }
    ]);
  });
});

describe("listOutreachSendFromOptions (cold email is a shorter list)", () => {
  it("offers Automatic plus the connected mailboxes, and never the coworker one", async () => {
    // Cold outreach has to leave from the tenant's own domain: it is the
    // address replies come back to, and the reputation a stranger's spam
    // report burns should be the sender's, not a platform domain shared by
    // every tenant. The prospecting send path only speaks Gmail/Outlook for
    // the same reason, so offering the coworker mailbox would be a dropdown
    // entry that cannot send.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      conn({ id: "c1", metadata: { provider_account_email: "sales@acme.test" } }),
      // Not a mailbox: a calendar-only grant cannot send, so it is not offered.
      conn({ id: "c2", provider_config_key: "google-calendar" }),
      conn({ id: "c3", provider_config_key: "outlook", metadata: {} })
    ]);
    expect(await listOutreachSendFromOptions(BIZ)).toEqual([
      { id: "", label: "Automatic", email: null },
      { id: "c1", label: "Gmail: sales@acme.test", email: "sales@acme.test" },
      // No metadata: labelled by provider rather than an empty address.
      { id: "c3", label: "Outlook", email: null }
    ]);
    // The coworker mailbox is never even looked up here.
    expect(getTenantMailbox).not.toHaveBeenCalled();
  });

  it("returns nothing at all when no mailbox is connected", async () => {
    // Not even the Automatic entry: on its own it would read as though
    // outreach were ready to send, when there is no send path at all. The
    // caller turns the empty list into a blocker.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      conn({ id: "c2", provider_config_key: "google-calendar" })
    ]);
    expect(await listOutreachSendFromOptions(BIZ)).toEqual([]);
  });
});
