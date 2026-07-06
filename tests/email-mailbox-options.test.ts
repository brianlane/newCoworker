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

import { connectionEmail, listSendFromOptions } from "@/lib/email/mailbox-options";
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
    created_at: "",
    updated_at: ""
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("connectionEmail", () => {
  it("prefers `email`", () => {
    expect(connectionEmail({ email: "a@x.com", end_user_email: "b@x.com" })).toBe("a@x.com");
  });
  it("falls back to end_user_email then end_user_display_name", () => {
    expect(connectionEmail({ end_user_email: "b@x.com" })).toBe("b@x.com");
    expect(connectionEmail({ end_user_display_name: "c@x.com" })).toBe("c@x.com");
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
