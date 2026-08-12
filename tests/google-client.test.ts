/**
 * The Google access-token manager.
 *
 * Google does NOT rotate refresh tokens, so unlike the Microsoft and Zoom
 * managers there is no lost-update hazard and no `updated_at` fence. The cases
 * that matter here are different:
 *
 *   - the stored refresh token must survive a refresh untouched, and the granted
 *     scope must not be blanked when Google omits it;
 *   - `invalid_grant` must deactivate, and `invalid_client` must NOT, because the
 *     second is what a botched secret rotation looks like and would otherwise
 *     take every tenant down at once;
 *   - null means "not connected", which is what the proxy turns into
 *     `email_not_connected`, so every not-usable shape has to return it rather
 *     than throw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceConnectionSecrets: vi.fn(),
  setWorkspaceConnectionActive: vi.fn(),
  updateWorkspaceConnectionAccessToken: vi.fn()
}));
vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/oauth")>();
  return { ...actual, refreshGoogleTokens: vi.fn() };
});

import {
  getWorkspaceConnectionSecrets,
  setWorkspaceConnectionActive,
  updateWorkspaceConnectionAccessToken
} from "@/lib/db/workspace-oauth-connections";
import { GoogleOAuthError, refreshGoogleTokens } from "@/lib/google/oauth";
import {
  GOOGLE_TOKEN_REFRESH_MARGIN_MS,
  getGoogleAccessToken,
  resetGoogleRefreshStateForTests
} from "@/lib/google/client";

const ROW = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = 1_770_000_000_000;

function secrets(over: Partial<Parameters<typeof Object.assign>[0]> = {}) {
  return {
    id: ROW,
    accessToken: "at-stored",
    refreshToken: "rt-stored",
    tokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    isActive: true,
    updatedAt: new Date(NOW).toISOString(),
    ...over
  };
}

beforeEach(() => {
  vi.mocked(getWorkspaceConnectionSecrets).mockReset();
  vi.mocked(setWorkspaceConnectionActive).mockReset();
  vi.mocked(updateWorkspaceConnectionAccessToken).mockReset();
  vi.mocked(refreshGoogleTokens).mockReset();
  vi.mocked(updateWorkspaceConnectionAccessToken).mockResolvedValue(true);
  resetGoogleRefreshStateForTests();
});

describe("getGoogleAccessToken", () => {
  it("returns the stored token without refreshing when it has runway", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(secrets() as never);
    await expect(getGoogleAccessToken(ROW, NOW)).resolves.toBe("at-stored");
    expect(refreshGoogleTokens).not.toHaveBeenCalled();
  });

  it("refreshes once the margin is reached", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW + GOOGLE_TOKEN_REFRESH_MARGIN_MS).toISOString() }) as never
    );
    vi.mocked(refreshGoogleTokens).mockResolvedValue({
      accessToken: "at-fresh",
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      grantedScope: "openid"
    });
    await expect(getGoogleAccessToken(ROW, NOW)).resolves.toBe("at-fresh");
    expect(refreshGoogleTokens).toHaveBeenCalledWith("rt-stored");
  });

  it("presents the stored refresh token and never writes a new one", async () => {
    // Google returns refreshToken: null. Persisting that, or clearing the
    // column, would break the row's check constraint and the next refresh.
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW).toISOString() }) as never
    );
    vi.mocked(refreshGoogleTokens).mockResolvedValue({
      accessToken: "at-fresh",
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      grantedScope: "openid https://www.googleapis.com/auth/gmail.modify"
    });
    await getGoogleAccessToken(ROW, NOW);
    expect(updateWorkspaceConnectionAccessToken).toHaveBeenCalledWith(ROW, {
      accessToken: "at-fresh",
      expiresAt: new Date(NOW + 3_600_000),
      scope: "openid https://www.googleapis.com/auth/gmail.modify"
    });
  });

  it("passes a null scope through so the stored one is left alone", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW).toISOString() }) as never
    );
    vi.mocked(refreshGoogleTokens).mockResolvedValue({
      accessToken: "at-fresh",
      refreshToken: null,
      expiresAt: new Date(NOW + 60_000),
      grantedScope: null
    });
    await getGoogleAccessToken(ROW, NOW);
    expect(updateWorkspaceConnectionAccessToken).toHaveBeenCalledWith(
      ROW,
      expect.objectContaining({ scope: null })
    );
  });

  it("single-flights concurrent callers into one token call", async () => {
    // Every poller wakes on the same minute boundary; without this they would
    // each hit Google for the same connection.
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW).toISOString() }) as never
    );
    let resolveRefresh: (v: unknown) => void = () => {};
    vi.mocked(refreshGoogleTokens).mockReturnValue(
      new Promise((res) => {
        resolveRefresh = res as (v: unknown) => void;
      }) as never
    );
    const a = getGoogleAccessToken(ROW, NOW);
    const b = getGoogleAccessToken(ROW, NOW);
    resolveRefresh({
      accessToken: "at-fresh",
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      grantedScope: null
    });
    await expect(Promise.all([a, b])).resolves.toEqual(["at-fresh", "at-fresh"]);
    expect(refreshGoogleTokens).toHaveBeenCalledTimes(1);
  });

  it("deactivates the row and returns null on invalid_grant", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW).toISOString() }) as never
    );
    vi.mocked(refreshGoogleTokens).mockRejectedValue(
      new GoogleOAuthError("invalid_grant", "Token has been expired or revoked", 400)
    );
    await expect(getGoogleAccessToken(ROW, NOW)).resolves.toBeNull();
    expect(setWorkspaceConnectionActive).toHaveBeenCalledWith(ROW, false);
  });

  it("does NOT deactivate on invalid_client, and propagates it", async () => {
    // Our credentials are wrong, not the owner's grant. Deactivating here would
    // disable every tenant the moment a secret rotation went wrong.
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW).toISOString() }) as never
    );
    vi.mocked(refreshGoogleTokens).mockRejectedValue(
      new GoogleOAuthError("request_failed", "Google token endpoint failed (401: invalid_client)", 401)
    );
    await expect(getGoogleAccessToken(ROW, NOW)).rejects.toThrow(/invalid_client/);
    expect(setWorkspaceConnectionActive).not.toHaveBeenCalled();
  });

  it("propagates a transient refresh failure without deactivating", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW).toISOString() }) as never
    );
    vi.mocked(refreshGoogleTokens).mockRejectedValue(
      new GoogleOAuthError("upstream_timeout", "Google token endpoint timed out")
    );
    await expect(getGoogleAccessToken(ROW, NOW)).rejects.toThrow(/timed out/);
    expect(setWorkspaceConnectionActive).not.toHaveBeenCalled();
  });

  it("still returns the fresh token when the write does not land", async () => {
    // Nothing rotated, so the token in hand is valid regardless of the write.
    // Failing the request here would be worse than a stale row.
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW).toISOString() }) as never
    );
    vi.mocked(updateWorkspaceConnectionAccessToken).mockResolvedValue(false);
    vi.mocked(refreshGoogleTokens).mockResolvedValue({
      accessToken: "at-fresh",
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      grantedScope: null
    });
    await expect(getGoogleAccessToken(ROW, NOW)).resolves.toBe("at-fresh");
  });

  it.each([
    ["no row (or a Nango row, which the reader rejects)", null],
    ["a soft-disabled row", { isActive: false }]
  ])("returns null for %s", async (_label, over) => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      (over === null ? null : secrets(over)) as never
    );
    await expect(getGoogleAccessToken(ROW, NOW)).resolves.toBeNull();
    expect(refreshGoogleTokens).not.toHaveBeenCalled();
  });

  it("treats an unparseable expiry as due for refresh rather than valid forever", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: "not-a-date" }) as never
    );
    vi.mocked(refreshGoogleTokens).mockResolvedValue({
      accessToken: "at-fresh",
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      grantedScope: null
    });
    await expect(getGoogleAccessToken(ROW, NOW)).resolves.toBe("at-fresh");
  });

  it("clears the single-flight entry so a later call can refresh again", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW).toISOString() }) as never
    );
    vi.mocked(refreshGoogleTokens).mockResolvedValue({
      accessToken: "at-fresh",
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      grantedScope: null
    });
    await getGoogleAccessToken(ROW, NOW);
    await getGoogleAccessToken(ROW, NOW);
    expect(refreshGoogleTokens).toHaveBeenCalledTimes(2);
  });
});
