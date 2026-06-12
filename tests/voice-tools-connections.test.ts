import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn()
}));

import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import {
  isEmailProviderConfigKey,
  providerFromKey,
  resolveCalendarConnection,
  resolveEmailConnection,
  resolveVoiceConnection
} from "@/lib/voice-tools/connections";

const businessId = "11111111-1111-4111-8111-111111111111";

function fakeRow(provider_config_key: string, connection_id = `cx-${provider_config_key}`) {
  return { provider_config_key, connection_id } as never;
}

describe("resolveVoiceConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no matching connection exists", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("slack")]);
    const res = await resolveVoiceConnection(businessId, ["google-mail", "outlook"]);
    expect(res).toBeNull();
  });

  it("prefers the first match in the preferred list", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      fakeRow("outlook"),
      fakeRow("google-mail")
    ]);
    const res = await resolveVoiceConnection(businessId, ["google-mail", "outlook"]);
    expect(res).not.toBeNull();
    expect(res!.provider).toBe("google");
    expect(res!.providerConfigKey).toBe("google-mail");
    expect(res!.connectionId).toBe("cx-google-mail");
  });

  it("resolveEmailConnection picks Google before Microsoft", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      fakeRow("outlook"),
      fakeRow("google-mail")
    ]);
    const res = await resolveEmailConnection(businessId);
    expect(res?.provider).toBe("google");
  });

  it("resolveEmailConnection falls back to Microsoft when Google is absent", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("outlook")]);
    const res = await resolveEmailConnection(businessId);
    expect(res?.provider).toBe("microsoft");
    expect(res?.providerConfigKey).toBe("outlook");
  });

  it("resolveCalendarConnection accepts google-calendar", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("google-calendar")]);
    const res = await resolveCalendarConnection(businessId);
    expect(res?.provider).toBe("google");
    expect(res?.providerConfigKey).toBe("google-calendar");
  });

  it("resolveCalendarConnection falls back to the broad google/outlook connections", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("outlook")]);
    const ms = await resolveCalendarConnection(businessId);
    expect(ms?.provider).toBe("microsoft");
    expect(ms?.providerConfigKey).toBe("outlook");

    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      fakeRow("outlook"),
      fakeRow("google")
    ]);
    const g = await resolveCalendarConnection(businessId);
    expect(g?.provider).toBe("google");
    expect(g?.providerConfigKey).toBe("google");
  });

  it("resolveCalendarConnection still prefers a dedicated calendar connection", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      fakeRow("google"),
      fakeRow("outlook-calendar")
    ]);
    const res = await resolveCalendarConnection(businessId);
    expect(res?.providerConfigKey).toBe("outlook-calendar");
  });
});

describe("isEmailProviderConfigKey / providerFromKey", () => {
  it("recognizes exactly the sendable mailbox keys", () => {
    expect(isEmailProviderConfigKey("google-mail")).toBe(true);
    expect(isEmailProviderConfigKey("gmail")).toBe(true);
    expect(isEmailProviderConfigKey("outlook")).toBe(true);
    expect(isEmailProviderConfigKey("google-calendar")).toBe(false);
    expect(isEmailProviderConfigKey("slack")).toBe(false);
  });
  it("maps keys to providers", () => {
    expect(providerFromKey("google-mail")).toBe("google");
    expect(providerFromKey("gmail")).toBe("google");
    expect(providerFromKey("outlook")).toBe("microsoft");
  });
});
