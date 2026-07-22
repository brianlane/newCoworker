import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn()
}));
vi.mock("@/lib/db/vagaro-connections", () => ({
  getActiveVagaroConnectionId: vi.fn()
}));
vi.mock("@/lib/db/calendly-connections", () => ({
  getActiveCalendlyConnectionId: vi.fn()
}));
vi.mock("@/lib/db/caldav-connections", () => ({
  getActiveCaldavConnectionId: vi.fn()
}));

import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { getActiveVagaroConnectionId } from "@/lib/db/vagaro-connections";
import { getActiveCalendlyConnectionId } from "@/lib/db/calendly-connections";
import { getActiveCaldavConnectionId } from "@/lib/db/caldav-connections";
import {
  CALDAV_DIRECT_KEY,
  CALENDLY_DIRECT_KEY,
  isEmailProviderConfigKey,
  isWorkspaceCalendarProvider,
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
    vi.mocked(getActiveVagaroConnectionId).mockResolvedValue(null);
    vi.mocked(getActiveCalendlyConnectionId).mockResolvedValue(null);
    vi.mocked(getActiveCaldavConnectionId).mockResolvedValue(null);
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

  it("resolveEmailConnection accepts the broad google workspace connection", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      fakeRow("outlook"),
      fakeRow("google")
    ]);
    const res = await resolveEmailConnection(businessId);
    expect(res?.provider).toBe("google");
    expect(res?.providerConfigKey).toBe("google");
  });

  it("resolveEmailConnection prefers a dedicated gmail connection over the broad google one", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      fakeRow("google"),
      fakeRow("gmail")
    ]);
    const res = await resolveEmailConnection(businessId);
    expect(res?.providerConfigKey).toBe("gmail");
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

  it("ignores a legacy Nango calendly row entirely (the fallback key was removed)", async () => {
    // A stray legacy row alone resolves nothing…
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("calendly")]);
    expect(await resolveCalendarConnection(businessId)).toBeNull();

    // …and never shadows the broad workspace fallbacks.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      fakeRow("calendly"),
      fakeRow("google")
    ]);
    const g = await resolveCalendarConnection(businessId);
    expect(g?.providerConfigKey).toBe("google");
    expect(g?.provider).toBe("google");
  });

  it("resolveCalendarConnection puts an active Vagaro connection ahead of everything", async () => {
    vi.mocked(getActiveVagaroConnectionId).mockResolvedValue("vagaro-row-1");
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("google-calendar")]);
    const res = await resolveCalendarConnection(businessId);
    expect(res).toEqual({
      provider: "vagaro",
      providerConfigKey: "vagaro",
      connectionId: "vagaro-row-1"
    });
    // Never even lists Nango connections once Vagaro answers.
    expect(listWorkspaceOAuthConnections).not.toHaveBeenCalled();
  });

  it("resolveCalendarConnection resolves a direct CalDAV connection", async () => {
    vi.mocked(getActiveCaldavConnectionId).mockResolvedValue("caldav-row-1");
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([]);
    const res = await resolveCalendarConnection(businessId);
    expect(res).toEqual({
      provider: "caldav",
      providerConfigKey: CALDAV_DIRECT_KEY,
      connectionId: "caldav-row-1"
    });
  });

  it("direct CalDAV loses to native calendars but beats Calendly (real booking > link-only)", async () => {
    vi.mocked(getActiveCaldavConnectionId).mockResolvedValue("caldav-row-1");
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("google-calendar")]);
    const native = await resolveCalendarConnection(businessId);
    expect(native?.providerConfigKey).toBe("google-calendar");

    vi.mocked(getActiveCalendlyConnectionId).mockResolvedValue("calendly-row-1");
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("calendly")]);
    const caldav = await resolveCalendarConnection(businessId);
    expect(caldav?.providerConfigKey).toBe(CALDAV_DIRECT_KEY);
    expect(caldav?.provider).toBe("caldav");
  });

  it("resolveCalendarConnection resolves a direct (PAT) Calendly connection", async () => {
    vi.mocked(getActiveCalendlyConnectionId).mockResolvedValue("calendly-row-1");
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([]);
    const res = await resolveCalendarConnection(businessId);
    expect(res).toEqual({
      provider: "calendly",
      providerConfigKey: CALENDLY_DIRECT_KEY,
      connectionId: "calendly-row-1"
    });
  });

  it("direct Calendly loses to native calendars but beats the broad fallbacks", async () => {
    vi.mocked(getActiveCalendlyConnectionId).mockResolvedValue("calendly-row-1");
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("google-calendar")]);
    const native = await resolveCalendarConnection(businessId);
    expect(native?.providerConfigKey).toBe("google-calendar");

    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([fakeRow("google")]);
    const direct = await resolveCalendarConnection(businessId);
    expect(direct?.providerConfigKey).toBe(CALENDLY_DIRECT_KEY);
    expect(direct?.provider).toBe("calendly");
  });
});

describe("isWorkspaceCalendarProvider", () => {
  it("is true only for google/microsoft", () => {
    expect(isWorkspaceCalendarProvider("google")).toBe(true);
    expect(isWorkspaceCalendarProvider("microsoft")).toBe(true);
    expect(isWorkspaceCalendarProvider("calendly")).toBe(false);
    expect(isWorkspaceCalendarProvider("vagaro")).toBe(false);
    expect(isWorkspaceCalendarProvider("caldav")).toBe(false);
  });
});

describe("isEmailProviderConfigKey / providerFromKey", () => {
  it("recognizes exactly the sendable mailbox keys", () => {
    expect(isEmailProviderConfigKey("google-mail")).toBe(true);
    expect(isEmailProviderConfigKey("gmail")).toBe(true);
    expect(isEmailProviderConfigKey("google")).toBe(true);
    expect(isEmailProviderConfigKey("outlook")).toBe(true);
    expect(isEmailProviderConfigKey("google-calendar")).toBe(false);
    expect(isEmailProviderConfigKey("slack")).toBe(false);
  });
  it("maps keys to providers", () => {
    expect(providerFromKey("google-mail")).toBe("google");
    expect(providerFromKey("gmail")).toBe("google");
    expect(providerFromKey("google")).toBe("google");
    expect(providerFromKey("outlook")).toBe("microsoft");
  });
});
