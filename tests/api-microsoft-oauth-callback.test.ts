/**
 * The Microsoft callback's reconnect decisions, driven through the ROUTE.
 *
 * The unit suite proves the matcher; this file proves the route actually
 * feeds it. Two producer contracts live here and nowhere else:
 *
 *  - the identity the route resolves (accountId, aliases) must reach
 *    findReconnectTarget and resolveUnlabeledReconnect. Dropping either
 *    argument used to pass the entire suite while silently disarming the
 *    alias matching and the different-id veto for every Microsoft connect.
 *  - the metadata KEY NAMES the route writes must be the ones the matcher
 *    reads. The round-trip tests below re-feed the route's own written
 *    metadata into findReconnectTarget, so renaming provider_account_* in
 *    one place breaks a test instead of production.
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
vi.mock("@/lib/nango/account-identity", () => ({
  fetchWorkspaceAccountIdentity: vi.fn()
}));

import { GET as CALLBACK } from "@/app/api/integrations/microsoft/callback/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
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
import { fetchWorkspaceAccountIdentity } from "@/lib/nango/account-identity";
import { findReconnectTarget, OUTLOOK_KEYS } from "@/lib/workspace/reconnect";
import type { WorkspaceOAuthConnectionRow } from "@/lib/db/workspace-oauth-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SYNTHETIC = "outlook_5c3966be918a1c30@outlook.com";
const REAL = "jane@gmail.com";
const CID = "graph-cid-1";

const outlookRow = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  business_id: BIZ,
  provider_config_key: "outlook",
  connection_id: "nango-1",
  metadata: {},
  transport: "nango" as const,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over
});

function callbackRequest() {
  const state = createMicrosoftOAuthState(BIZ);
  return new Request(
    `http://localhost/api/integrations/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`
  );
}

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
  vi.mocked(exchangeMicrosoftAuthCode).mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: new Date("2026-08-11T12:00:00Z"),
    scope: "Mail.Send",
    idTokenEmail: null
  });
  // A personal account that answers at both its real address and the
  // synthetic UPN, and carries the Graph id. This is the identity whose
  // wiring the whole file pins.
  vi.mocked(fetchMicrosoftIdentity).mockResolvedValue({
    accountId: CID,
    email: REAL,
    displayName: "Jane",
    aliases: [REAL, SYNTHETIC]
  });
  vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
    used: 1,
    max: 3,
    atCap: false
  });
  vi.mocked(assertWorkspaceConnectionAllowed).mockResolvedValue(undefined as never);
  vi.mocked(insertDirectWorkspaceConnection).mockResolvedValue(
    outlookRow({ id: "row-new", transport: "direct" }) as never
  );
  vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
    state: { used: 1, max: 3, atCap: false },
    evictRowId: null
  } as never);
});

describe("microsoft callback: the identity's aliases reach the matcher", () => {
  it("flips a row labeled with the synthetic UPN when the connect resolves the real address", async () => {
    // Nothing but identity.aliases can make this match: the stored label and
    // the resolved primary are different strings for one mailbox.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      outlookRow({ metadata: { provider_account_email: SYNTHETIC } })
    ] as never);

    const res = await CALLBACK(callbackRequest());

    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "row-1" })
    );
    expect(insertDirectWorkspaceConnection).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("workspace=connected");
  });
});

describe("microsoft callback: the verify path probes through the transport seam", () => {
  const unlabeled = () => outlookRow({ metadata: {} });

  it("adopts the sole unlabeled row when the probe reports another spelling of this account", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([unlabeled()] as never);
    // The probe runs through the row's own grant, which for a personal
    // account reports the synthetic UPN (and, being a legacy grant, no id).
    vi.mocked(fetchWorkspaceAccountIdentity).mockResolvedValue({
      email: SYNTHETIC,
      displayName: null,
      accountId: null
    });

    await CALLBACK(callbackRequest());

    expect(fetchWorkspaceAccountIdentity).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ connectionId: "nango-1", providerConfigKey: "outlook" })
    );
    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "row-1" })
    );
    expect(insertDirectWorkspaceConnection).not.toHaveBeenCalled();
  });

  it("refuses to adopt when the probed account id differs, even at the same address", async () => {
    // Two distinct accounts can share an address (work via otherMails,
    // personal as its primary). The probed id settles it: this row belongs to
    // someone else, so the connect inserts rather than re-pointing it.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([unlabeled()] as never);
    vi.mocked(fetchWorkspaceAccountIdentity).mockResolvedValue({
      email: REAL,
      displayName: null,
      accountId: "a-different-account"
    });

    await CALLBACK(callbackRequest());

    expect(flipWorkspaceConnectionToDirect).not.toHaveBeenCalled();
    expect(insertDirectWorkspaceConnection).toHaveBeenCalled();
  });

  it("adopts on probed id equality even when the probe's spelling is foreign", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([unlabeled()] as never);
    vi.mocked(fetchWorkspaceAccountIdentity).mockResolvedValue({
      email: "unrecognized@spelling.example",
      displayName: null,
      accountId: CID
    });

    await CALLBACK(callbackRequest());

    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "row-1" })
    );
  });

  it("inserts rather than adopting when the probe fails", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([unlabeled()] as never);
    vi.mocked(fetchWorkspaceAccountIdentity).mockRejectedValue(new Error("dead grant"));

    await CALLBACK(callbackRequest());

    expect(insertDirectWorkspaceConnection).toHaveBeenCalled();
    expect(flipWorkspaceConnectionToDirect).not.toHaveBeenCalled();
  });
});

describe("microsoft callback: written metadata round-trips into the matcher", () => {
  it("a later connect matches the row this connect wrote, by id, by alias, and vetoes a stranger", async () => {
    // Drive the route to a fresh insert and capture the metadata it wrote.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([] as never);

    await CALLBACK(callbackRequest());

    const written = vi.mocked(insertDirectWorkspaceConnection).mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    const rowFromWrite = outlookRow({
      id: "written-row",
      metadata: written.metadata
    }) as WorkspaceOAuthConnectionRow;

    // Same account reconnecting later: the stored id matches.
    expect(
      findReconnectTarget([rowFromWrite], REAL, 3, OUTLOOK_KEYS, CID, [REAL, SYNTHETIC])
    ).toMatchObject({ kind: "reconnect", matchedBy: "account_id" });

    // Same account resolving ONLY the synthetic spelling: the stored alias
    // set matches (no id supplied, the legacy-path shape).
    expect(
      findReconnectTarget([rowFromWrite], SYNTHETIC, 3, OUTLOOK_KEYS, null, [SYNTHETIC])
    ).toMatchObject({ kind: "reconnect", matchedBy: "account_email" });

    // A DIFFERENT account at the same address: the stored id vetoes the
    // email match, which is the protection the key names exist to feed.
    expect(
      findReconnectTarget([rowFromWrite], REAL, 3, OUTLOOK_KEYS, "someone-else", [REAL]).kind
    ).toBe("new");
  });
});
