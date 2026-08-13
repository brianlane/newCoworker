/**
 * The Google connect and callback routes.
 *
 * The cases that matter are the ones where getting it wrong is silent:
 *
 *  - a RECONNECT must flip the EXISTING row in place, keeping its id. That id is
 *    embedded in AiFlow `send_email` steps, so a new row means every bound flow
 *    dies at send time with connection_not_found. It must also work ACROSS
 *    transports and across all four legacy Google keys, since carrying a Nango
 *    tenant over is the entire point.
 *  - an at-cap owner who already holds a Google row must still be let through,
 *    or a Starter tenant (cap 1, one Nango row) is permanently stranded on
 *    Nango: the thing this migration exists to prevent.
 *  - a grant we take and then cannot use must be handed BACK. Google has a
 *    revoke endpoint, so leaving one live on the owner's account pointing at no
 *    row is a choice, not a limitation.
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
vi.mock("@/lib/google/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/oauth")>()),
  exchangeGoogleAuthCode: vi.fn(),
  fetchGoogleIdentity: vi.fn(),
  revokeGoogleToken: vi.fn()
}));
vi.mock("@/lib/nango/account-identity", () => ({
  fetchWorkspaceAccountIdentity: vi.fn()
}));

import { GET as CONNECT } from "@/app/api/integrations/google/connect/route";
import { GET as CALLBACK } from "@/app/api/auth/callback/google/route";
import { getAuthUser } from "@/lib/auth";
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
  createGoogleOAuthState,
  exchangeGoogleAuthCode,
  fetchGoogleIdentity,
  revokeGoogleToken
} from "@/lib/google/oauth";
import { fetchWorkspaceAccountIdentity } from "@/lib/nango/account-identity";

const BIZ = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";

const nangoRow = (over: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  business_id: BIZ,
  provider_config_key: "google",
  connection_id: "nango-conn",
  metadata: { provider_account_email: "owner@acme.com" },
  transport: "nango",
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  ...over
});

function tokenSet() {
  return {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: new Date("2026-08-12T00:00:00Z"),
    grantedScope: "openid https://www.googleapis.com/auth/gmail.modify"
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_CLIENT_ID = "354099628168-test.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com";
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "test-signing-key";
  vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@acme.com", isAdmin: false } as never);
  vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
    atCap: false,
    used: 0,
    max: 3
  } as never);
  vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([]);
  vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
    evictRowId: null,
    state: { atCap: false, used: 1, max: 3 }
  } as never);
  vi.mocked(insertDirectWorkspaceConnection).mockResolvedValue({ id: "new-row" } as never);
  vi.mocked(exchangeGoogleAuthCode).mockResolvedValue(tokenSet() as never);
  vi.mocked(fetchGoogleIdentity).mockResolvedValue({
    accountId: "sub-1",
    email: "Owner@Acme.com",
    displayName: "Owner"
  } as never);
  vi.mocked(revokeGoogleToken).mockResolvedValue(true);
});

function connectRequest() {
  return new Request(
    `https://www.newcoworker.com/api/integrations/google/connect?businessId=${BIZ}`
  );
}

function callbackRequest(state = createGoogleOAuthState(BIZ)) {
  return new Request(
    `https://www.newcoworker.com/api/auth/callback/google?code=code-1&state=${encodeURIComponent(state)}`
  );
}

describe("google connect route", () => {
  it("sends the owner to Google's consent screen with a signed state", async () => {
    const res = await CONNECT(connectRequest());
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    // prompt=consent is what makes Google return a refresh token, so it must be
    // on EVERY authorize, not only reconnects.
    expect(target.searchParams.get("prompt")).toBe("consent");
    expect(target.searchParams.get("access_type")).toBe("offline");
    expect(target.searchParams.get("state")).toBeTruthy();
  });

  it("refuses at the cap when there is no Google row to reconnect", async () => {
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
      atCap: true,
      used: 1,
      max: 1
    } as never);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      nangoRow({ provider_config_key: "outlook" })
    ] as never);
    const res = await CONNECT(connectRequest());
    expect(res.headers.get("location")).toContain("error=");
  });

  it.each(["google", "gmail", "google-mail", "google-calendar"])(
    "lets an at-cap owner holding a %s row through, so they can migrate",
    async (key) => {
      // The case that matters most: a Starter tenant, cap 1, already on Nango.
      // Refusing here strands them on Nango permanently, because they cannot add
      // and often cannot remove either (the delete guard blocks while a flow
      // binds the row).
      vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
        atCap: true,
        used: 1,
        max: 1
      } as never);
      vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
        nangoRow({ provider_config_key: key })
      ] as never);
      const res = await CONNECT(connectRequest());
      expect(res.headers.get("location")).toContain("accounts.google.com");
    }
  );

  it("sends an unauthenticated visitor to login and back", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await CONNECT(connectRequest());
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login?redirectTo=");
    expect(decodeURIComponent(location)).toContain("/api/integrations/google/connect");
  });

  it("reports a misconfigured server rather than redirecting to a broken URL", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await CONNECT(connectRequest());
    expect(res.headers.get("location")).toContain("not+configured");
  });
});

describe("google callback route", () => {
  it("flips an existing Nango row in place, keeping its id", async () => {
    // The row id is embedded in AiFlow send_email steps. A new row here means
    // every bound flow dies at send time.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([nangoRow()] as never);

    const res = await CALLBACK(callbackRequest());

    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalledWith(
      expect.objectContaining({ id: ROW_ID, businessId: BIZ })
    );
    expect(insertDirectWorkspaceConnection).not.toHaveBeenCalled();
    // No seat consumed, so the cap is never asserted on this path.
    expect(assertWorkspaceConnectionAllowed).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("workspace=connected");
  });

  it("preserves app-owned metadata across the flip", async () => {
    // The shared-calendar id and its ACL live in metadata. Losing them gives the
    // tenant a second "NewCoworker" calendar and re-shares it with everyone.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      nangoRow({
        metadata: {
          provider_account_email: "owner@acme.com",
          shared_calendar_id: "cal-123",
          shared_calendar_acl: ["a@b.com"]
        }
      })
    ] as never);

    await CALLBACK(callbackRequest());

    const args = vi.mocked(flipWorkspaceConnectionToDirect).mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(args.metadata.shared_calendar_id).toBe("cal-123");
    expect(args.metadata.shared_calendar_acl).toEqual(["a@b.com"]);
    expect(args.metadata.connected_via).toBe("google_oauth");
  });

  it("records the Nango connection it replaced, so rollback stays possible", async () => {
    // The flip overwrites connection_id with a synthetic direct:<uuid>, so this
    // is the ONLY remaining pointer to the Nango grant, which is left alive.
    // debug/nango-audit.ts reads it to tell a deliberately-retained rollback
    // grant from a genuine orphan; without it the audit offers to delete the one
    // thing that makes this reversible.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([nangoRow()] as never);

    await CALLBACK(callbackRequest());

    const args = vi.mocked(flipWorkspaceConnectionToDirect).mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(args.metadata.migrated_from_nango_connection_id).toBe("nango-conn");
    expect(args.metadata.migrated_from_provider_config_key).toBe("google");
    expect(args.metadata.migrated_at).toEqual(expect.any(String));
  });

  it("does not claim a rollback pointer when the row was already first-party", async () => {
    // Re-consenting an already-direct row has no Nango grant behind it, and a
    // stale pointer would make the audit protect a seat that no longer exists.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      nangoRow({ transport: "direct", connection_id: "direct:old" })
    ] as never);

    await CALLBACK(callbackRequest());

    const args = vi.mocked(flipWorkspaceConnectionToDirect).mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(args.metadata).not.toHaveProperty("migrated_from_nango_connection_id");
  });

  it("stores the GRANTED scope, not the scope set we asked for", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([nangoRow()] as never);
    await CALLBACK(callbackRequest());
    const args = vi.mocked(flipWorkspaceConnectionToDirect).mock.calls[0][0] as {
      tokens: { scope: string; refreshToken: string };
    };
    expect(args.tokens.scope).toBe("openid https://www.googleapis.com/auth/gmail.modify");
    expect(args.tokens.refreshToken).toBe("rt");
  });

  it("inserts a new row for a genuinely different account, and takes a seat", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      nangoRow({ metadata: { provider_account_email: "someone.else@acme.com" } })
    ] as never);

    await CALLBACK(callbackRequest());

    expect(assertWorkspaceConnectionAllowed).toHaveBeenCalledWith(BIZ);
    expect(insertDirectWorkspaceConnection).toHaveBeenCalledWith(
      expect.objectContaining({ providerConfigKey: "google" })
    );
    expect(flipWorkspaceConnectionToDirect).not.toHaveBeenCalled();
  });

  it("keeps provider_config_key as google, never a -direct synthetic key", async () => {
    // The key is identical across transports; that is what keeps every resolver
    // and mailbox binding transport-blind.
    await CALLBACK(callbackRequest());
    const args = vi.mocked(insertDirectWorkspaceConnection).mock.calls[0][0] as {
      providerConfigKey: string;
      connectionId: string;
    };
    expect(args.providerConfigKey).toBe("google");
    expect(args.connectionId).toMatch(/^direct:/);
  });

  it("hands the grant back when the account cannot be read", async () => {
    vi.mocked(fetchGoogleIdentity).mockResolvedValue(null as never);
    const res = await CALLBACK(callbackRequest());
    expect(revokeGoogleToken).toHaveBeenCalledWith("rt");
    expect(insertDirectWorkspaceConnection).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("error=");
  });

  it("hands the grant back when it loses a cap race", async () => {
    vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
      evictRowId: "new-row",
      state: { atCap: true, used: 1, max: 1 }
    } as never);
    const res = await CALLBACK(callbackRequest());
    expect(deleteWorkspaceOAuthConnection).toHaveBeenCalledWith(BIZ, "new-row");
    expect(revokeGoogleToken).toHaveBeenCalledWith("rt");
    expect(res.headers.get("location")).toContain("error=");
  });

  it("consolidates onto an older row when two callbacks race", async () => {
    vi.mocked(listWorkspaceOAuthConnections)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        nangoRow({ id: "older", created_at: "2026-06-01T00:00:00Z" }),
        nangoRow({ id: "new-row", created_at: "2026-08-01T00:00:00Z" })
      ] as never);

    const res = await CALLBACK(callbackRequest());

    expect(deleteWorkspaceOAuthConnection).toHaveBeenCalledWith(BIZ, "new-row");
    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "older" })
    );
    expect(res.headers.get("location")).toContain("workspace=connected");
  });

  it("probes an unlabeled row rather than guessing, and adopts it on a match", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      nangoRow({ metadata: {} })
    ] as never);
    vi.mocked(fetchWorkspaceAccountIdentity).mockResolvedValue({
      email: "owner@acme.com"
    } as never);

    await CALLBACK(callbackRequest());

    expect(fetchWorkspaceAccountIdentity).toHaveBeenCalled();
    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalledWith(
      expect.objectContaining({ id: ROW_ID })
    );
  });

  it("probes an unlabeled DIRECT row through the seam, not through Nango", async () => {
    // The reason fetchWorkspaceAccountIdentity exists. Google was deleted from
    // Nango on 2026-08-13, so a Nango-only probe of a Google row can only fail,
    // and KYP's row is unlabeled (end_user_email only). Without this the owner
    // would get a DUPLICATE row on reconnect instead of their existing one
    // being adopted, silently consuming a connection seat.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      nangoRow({ transport: "direct", connection_id: "direct:existing", metadata: {} })
    ] as never);
    vi.mocked(fetchWorkspaceAccountIdentity).mockResolvedValue({
      email: "owner@acme.com"
    } as never);

    await CALLBACK(callbackRequest());

    expect(fetchWorkspaceAccountIdentity).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ connectionId: "direct:existing" })
    );
    expect(flipWorkspaceConnectionToDirect).toHaveBeenCalledWith(
      expect.objectContaining({ id: ROW_ID })
    );
    expect(insertDirectWorkspaceConnection).not.toHaveBeenCalled();
  });

  it("inserts rather than adopting when the probe fails", async () => {
    // A duplicate is recoverable; re-pointing a live flow at a different mailbox
    // is not. So a failed probe must never adopt.
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      nangoRow({ metadata: {} })
    ] as never);
    vi.mocked(fetchWorkspaceAccountIdentity).mockRejectedValue(new Error("dead grant"));

    await CALLBACK(callbackRequest());

    expect(insertDirectWorkspaceConnection).toHaveBeenCalled();
    expect(flipWorkspaceConnectionToDirect).not.toHaveBeenCalled();
  });

  it("refuses a state minted for a different signing key", async () => {
    const foreign = createGoogleOAuthState(BIZ);
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "rotated-key";
    const res = await CALLBACK(callbackRequest(foreign));
    expect(res.headers.get("location")).toContain("expired");
    expect(exchangeGoogleAuthCode).not.toHaveBeenCalled();
  });

  it.each([
    ["access_denied", "cancelled"],
    ["server_error", "failed"]
  ])("reports %s without exchanging anything", async (err, expected) => {
    const res = await CALLBACK(
      new Request(`https://www.newcoworker.com/api/auth/callback/google?error=${err}`)
    );
    expect(res.headers.get("location")).toContain(expected);
    expect(exchangeGoogleAuthCode).not.toHaveBeenCalled();
  });

  it("preserves code and state through a sign-in detour", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await CALLBACK(callbackRequest());
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    expect(location).toContain("/login?redirectTo=");
    expect(location).toContain("/api/auth/callback/google");
    expect(location).toContain("code=code-1");
  });

  it("surfaces a rejected authorization as a retry, not a generic failure", async () => {
    const { GoogleOAuthError } = await import("@/lib/google/oauth");
    vi.mocked(exchangeGoogleAuthCode).mockRejectedValue(
      new GoogleOAuthError("invalid_grant", "bad code", 400)
    );
    const res = await CALLBACK(callbackRequest());
    expect(res.headers.get("location")).toContain("rejected");
  });
});
