/**
 * Tier-cap behavior across the Microsoft connect and callback routes.
 *
 * Both cases here came from Bugbot on #1289 and are about the same tension:
 * a RECONNECT consumes no seat, but which account an owner will pick is
 * unknowable until after consent. Getting the balance wrong either wastes a
 * consent round-trip or, worse, permanently strands an at-cap tenant on Nango.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));
vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn(),
  insertDirectWorkspaceConnection: vi.fn(),
  flipWorkspaceConnectionToDirect: vi.fn(),
  deleteWorkspaceOAuthConnection: vi.fn()
}));
vi.mock("@/lib/nango/connection-cap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nango/connection-cap")>()),
  resolveWorkspaceConnectionCapState: vi.fn(),
  assertWorkspaceConnectionAllowed: vi.fn(),
  settleWorkspaceConnectionInsert: vi.fn()
}));
vi.mock("@/lib/microsoft/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/microsoft/oauth")>()),
  exchangeMicrosoftAuthCode: vi.fn(),
  fetchMicrosoftIdentity: vi.fn()
}));

import { GET as CONNECT } from "@/app/api/integrations/microsoft/connect/route";
import { GET as CALLBACK } from "@/app/api/integrations/microsoft/callback/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  deleteWorkspaceOAuthConnection,
  flipWorkspaceConnectionToDirect,
  insertDirectWorkspaceConnection,
  listWorkspaceOAuthConnections
} from "@/lib/db/workspace-oauth-connections";
import {
  assertWorkspaceConnectionAllowed,
  resolveWorkspaceConnectionCapState,
  settleWorkspaceConnectionInsert
} from "@/lib/nango/connection-cap";
import {
  createMicrosoftOAuthState,
  exchangeMicrosoftAuthCode,
  fetchMicrosoftIdentity
} from "@/lib/microsoft/oauth";

const BIZ = "11111111-1111-4111-8111-111111111111";

const outlookRow = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  business_id: BIZ,
  provider_config_key: "outlook",
  connection_id: "nango-1",
  metadata: { provider_account_email: "sam@acme.com" },
  transport: "nango" as const,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over
});

const AT_CAP = { used: 1, max: 1, atCap: true };
const UNDER_CAP = { used: 0, max: 3, atCap: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MICROSOFT_CLIENT_ID", "client-abc");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "secret-xyz");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://newcoworker.com");
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "unit-test-key");
  vi.mocked(getAuthUser).mockResolvedValue({
    userId: "u1",
    email: "owner@example.com",
    isAdmin: false
  } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
});

function connectRequest() {
  return new Request(
    `http://localhost/api/integrations/microsoft/connect?businessId=${BIZ}`
  );
}

describe("microsoft connect: cap gate before consent", () => {
  it("refuses at cap when the business has NO Outlook row (can only be a new one)", async () => {
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue(AT_CAP);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      outlookRow({ provider_config_key: "gmail" })
    ]);

    const res = await CONNECT(connectRequest());

    // Bounced back to the dashboard, never sent to Microsoft.
    expect(res.status).toBe(307);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("/dashboard/integrations/workspace");
    expect(loc).toContain("error=");
    expect(loc).not.toContain("login.microsoftonline.com");
  });

  it("ALLOWS an at-cap owner through when an Outlook row exists (a reconnect uses no seat)", async () => {
    // The case the whole migration depends on: a Starter tenant, cap 1, one
    // Nango Outlook row, moving it to first-party. Refusing here would strand
    // them on Nango permanently.
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue(AT_CAP);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([outlookRow()]);

    const res = await CONNECT(connectRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("location") ?? "").toContain(
      "login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
  });

  it("does not even read the rows when under the cap", async () => {
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue(UNDER_CAP);

    const res = await CONNECT(connectRequest());

    expect(res.headers.get("location") ?? "").toContain("login.microsoftonline.com");
    expect(listWorkspaceOAuthConnections).not.toHaveBeenCalled();
  });
});

describe("microsoft callback: insert race settlement", () => {
  function callbackRequest() {
    const state = createMicrosoftOAuthState(BIZ);
    return new Request(
      `http://localhost/api/integrations/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`
    );
  }

  beforeEach(() => {
    vi.mocked(exchangeMicrosoftAuthCode).mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: new Date("2026-08-11T12:00:00Z"),
      scope: "Mail.Send",
  idTokenEmail: null
    });
    vi.mocked(fetchMicrosoftIdentity).mockResolvedValue({
      accountId: "u1",
      email: "new@acme.com",
      displayName: "New Box",
      aliases: []
    });
    vi.mocked(assertWorkspaceConnectionAllowed).mockResolvedValue(undefined as never);
    vi.mocked(insertDirectWorkspaceConnection).mockResolvedValue(
      outlookRow({ id: "row-new", transport: "direct" }) as never
    );
  });

  it("keeps the row when the settlement says it fits", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([]);
    vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
      state: UNDER_CAP,
      evictRowId: null
    });

    const res = await CALLBACK(callbackRequest());

    expect(deleteWorkspaceOAuthConnection).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toContain("workspace=connected");
  });

  it("evicts its own row when it lost the race and landed past the cap", async () => {
    // Two parallel callbacks can both pass the pre-insert count check, so the
    // post-insert settlement is the only thing keeping a tenant at or under
    // their cap.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([]);
    vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
      state: AT_CAP,
      evictRowId: "row-new"
    });

    const res = await CALLBACK(callbackRequest());

    expect(deleteWorkspaceOAuthConnection).toHaveBeenCalledWith(BIZ, "row-new");
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("error=");
    expect(loc).not.toContain("workspace=connected");
  });

  it("never settles on a reconnect, which consumes no seat", async () => {
    vi.mocked(fetchMicrosoftIdentity).mockResolvedValue({
      accountId: "u1",
      email: "sam@acme.com",
      displayName: "Sam",
      aliases: []
    });
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([outlookRow()]);
    vi.mocked(flipWorkspaceConnectionToDirect).mockResolvedValue(
      outlookRow({ transport: "direct" }) as never
    );

    const res = await CALLBACK(callbackRequest());

    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalled();
    expect(assertWorkspaceConnectionAllowed).not.toHaveBeenCalled();
    expect(settleWorkspaceConnectionInsert).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toContain("workspace=connected");
  });

describe("connecting a SECOND, different Outlook account", () => {
  const WORK_ID = "4ffc09dd-f1b2-4e9c-b6b1-10040358b815";
  const PERSONAL_ID = "5c3966be918a1c30";

  function callbackRequest() {
    const state = createMicrosoftOAuthState(BIZ);
    return new Request(
      `http://localhost/api/integrations/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`
    );
  }

  function arrivePersonalAccount() {
    vi.mocked(exchangeMicrosoftAuthCode).mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: new Date("2026-08-13T12:00:00Z"),
      scope: "Mail.Send",
      idTokenEmail: "team@newcoworker.com"
    });
    vi.mocked(fetchMicrosoftIdentity).mockResolvedValue({
      accountId: PERSONAL_ID,
      email: "team@newcoworker.com",
      displayName: "Team",
      aliases: ["team@newcoworker.com"]
    });
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({ used: 2, max: 3, atCap: false });
    vi.mocked(assertWorkspaceConnectionAllowed).mockResolvedValue(undefined as never);
    vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
      state: { used: 3, max: 3, atCap: true },
      evictRowId: null
    });
  }

  it("inserts a new row and leaves the other account's row alone", async () => {
    // The production report. The existing row is a DIFFERENT Microsoft account
    // that happens to answer at the same address, which is what collapsed the
    // two onto one row before the account-id veto.
    //
    // The two list() calls return different things on purpose: the second is
    // the post-insert read that feeds findDuplicateRow. Returning the same list
    // twice would leave that path with a single row, where it bails on count
    // alone and the no-delete assertion below would pass even if consolidation
    // matching were wrong.
    arrivePersonalAccount();
    const existingWorkRow = outlookRow({
      id: "work-row",
      transport: "direct",
      metadata: {
        provider_account_email: "team@newcoworker.com",
        provider_account_id: WORK_ID,
        provider_account_aliases: ["team@newcoworker.onmicrosoft.com", "team@newcoworker.com"]
      }
    });
    const insertedRow = outlookRow({
      id: "personal-row",
      transport: "direct",
      created_at: "2026-08-13T15:26:00Z",
      metadata: {
        provider_account_email: "team@newcoworker.com",
        provider_account_id: PERSONAL_ID
      }
    });
    vi.mocked(listWorkspaceOAuthConnections)
      .mockResolvedValueOnce([existingWorkRow] as never)
      .mockResolvedValueOnce([existingWorkRow, insertedRow] as never);
    vi.mocked(insertDirectWorkspaceConnection).mockResolvedValue(insertedRow as never);

    const res = await CALLBACK(callbackRequest());

    // Both matchers see two same-address rows and must still decline: the ids
    // differ. Without the veto this deletes the new row and flips the work row.
    expect(insertDirectWorkspaceConnection).toHaveBeenCalled();
    expect(flipWorkspaceConnectionToDirect).not.toHaveBeenCalled();
    expect(deleteWorkspaceOAuthConnection).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toContain("workspace=connected");
  });

  it("still consolidates a genuine duplicate of the SAME account", async () => {
    // The counterweight: the veto must not disable real consolidation, or two
    // concurrent connects for one mailbox leave split bindings.
    arrivePersonalAccount();
    const olderSameAccount = outlookRow({
      id: "older-row",
      transport: "direct",
      created_at: "2026-01-01T00:00:00Z",
      metadata: {
        provider_account_email: "team@newcoworker.com",
        provider_account_id: PERSONAL_ID
      }
    });
    const insertedRow = outlookRow({
      id: "raced-row",
      transport: "direct",
      created_at: "2026-08-13T15:26:00Z",
      metadata: {
        provider_account_email: "team@newcoworker.com",
        provider_account_id: PERSONAL_ID
      }
    });
    vi.mocked(listWorkspaceOAuthConnections)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([olderSameAccount, insertedRow] as never);
    vi.mocked(insertDirectWorkspaceConnection).mockResolvedValue(insertedRow as never);
    vi.mocked(flipWorkspaceConnectionToDirect).mockResolvedValue(olderSameAccount as never);

    const res = await CALLBACK(callbackRequest());

    expect(deleteWorkspaceOAuthConnection).toHaveBeenCalledWith(BIZ, "raced-row");
    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "older-row" })
    );
    expect(res.headers.get("location") ?? "").toContain("workspace=connected");
  });
});

});
