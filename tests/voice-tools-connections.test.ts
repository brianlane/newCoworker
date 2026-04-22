import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn()
}));

import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import {
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
});
