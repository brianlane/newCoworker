/**
 * The Microsoft access-token manager.
 *
 * Most of these cases are about ROTATION races. Microsoft invalidates the
 * presented refresh token on every refresh, so the interesting failures are
 * not "the network broke" but "two things refreshed at once": the in-process
 * single-flight, and the cross-instance updated_at fence that the map cannot
 * see. Getting either wrong strands a healthy connection as permanently
 * disconnected, which is silent and expensive.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceConnectionSecrets: vi.fn(),
  setWorkspaceConnectionActive: vi.fn(),
  updateWorkspaceConnectionTokens: vi.fn()
}));
vi.mock("@/lib/microsoft/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/microsoft/oauth")>();
  return { ...actual, refreshMicrosoftTokens: vi.fn() };
});

import {
  getWorkspaceConnectionSecrets,
  setWorkspaceConnectionActive,
  updateWorkspaceConnectionTokens
} from "@/lib/db/workspace-oauth-connections";
import { MicrosoftOAuthError, refreshMicrosoftTokens } from "@/lib/microsoft/oauth";
import {
  getMicrosoftAccessToken,
  MICROSOFT_TOKEN_REFRESH_MARGIN_MS,
  resetMicrosoftRefreshStateForTests
} from "@/lib/microsoft/client";

const ROW_ID = "22222222-2222-4222-8222-222222222222";
const NOW = 1_760_000_000_000;

const secrets = (over: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  accessToken: "at-old",
  refreshToken: "rt-old",
  // Comfortably valid unless a case overrides it.
  tokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
  isActive: true,
  updatedAt: "2026-08-01T00:00:00Z",
  ...over
});

const rotated = {
  accessToken: "at-new",
  refreshToken: "rt-new",
  expiresAt: new Date(NOW + 3_600_000),
  scope: "Mail.Send"
};

beforeEach(() => {
  vi.clearAllMocks();
  resetMicrosoftRefreshStateForTests();
  vi.mocked(updateWorkspaceConnectionTokens).mockResolvedValue(true);
});

describe("getMicrosoftAccessToken", () => {
  it("returns null when there is no row", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(null);
    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBeNull();
    expect(refreshMicrosoftTokens).not.toHaveBeenCalled();
  });

  it("returns null for a soft-disabled row", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(secrets({ isActive: false }));
    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBeNull();
  });

  it("returns the stored token while it is comfortably valid", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(secrets());
    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-old");
    expect(refreshMicrosoftTokens).not.toHaveBeenCalled();
  });

  it("refreshes once inside the expiry margin", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({
        tokenExpiresAt: new Date(NOW + MICROSOFT_TOKEN_REFRESH_MARGIN_MS - 1).toISOString()
      })
    );
    vi.mocked(refreshMicrosoftTokens).mockResolvedValue(rotated);

    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-new");
    expect(refreshMicrosoftTokens).toHaveBeenCalledWith("rt-old");
  });

  it("refreshes an already-expired token", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW - 1000).toISOString() })
    );
    vi.mocked(refreshMicrosoftTokens).mockResolvedValue(rotated);
    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-new");
  });

  it("refreshes when the stored expiry is unparseable", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: "not-a-date" })
    );
    vi.mocked(refreshMicrosoftTokens).mockResolvedValue(rotated);
    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-new");
  });

  it("persists the rotated pair BEFORE handing the token out", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() })
    );
    vi.mocked(refreshMicrosoftTokens).mockResolvedValue(rotated);

    await getMicrosoftAccessToken(ROW_ID, NOW);

    // Fenced on the updated_at the refresh token was read from.
    expect(updateWorkspaceConnectionTokens).toHaveBeenCalledWith(
      ROW_ID,
      rotated,
      "2026-08-01T00:00:00Z"
    );
  });

  it("single-flights concurrent callers so the rotated token is not burned twice", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() })
    );
    let resolveRefresh: (v: typeof rotated) => void = () => {};
    vi.mocked(refreshMicrosoftTokens).mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );

    const both = Promise.all([
      getMicrosoftAccessToken(ROW_ID, NOW),
      getMicrosoftAccessToken(ROW_ID, NOW)
    ]);
    resolveRefresh(rotated);

    await expect(both).resolves.toEqual(["at-new", "at-new"]);
    expect(refreshMicrosoftTokens).toHaveBeenCalledTimes(1);
  });

  it("keys the single-flight by ROW, so two mailboxes refresh independently", async () => {
    // Unlike Zoom (one connection per business) a business can hold several
    // Microsoft mailboxes; keying by business would cross their rotations.
    const other = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getWorkspaceConnectionSecrets).mockImplementation(async (id: string) =>
      secrets({ id, tokenExpiresAt: new Date(NOW - 1).toISOString() })
    );
    vi.mocked(refreshMicrosoftTokens).mockResolvedValue(rotated);

    await Promise.all([
      getMicrosoftAccessToken(ROW_ID, NOW),
      getMicrosoftAccessToken(other, NOW)
    ]);

    expect(refreshMicrosoftTokens).toHaveBeenCalledTimes(2);
  });

  it("adopts the winner's token when the fence rejects our write", async () => {
    vi.mocked(getWorkspaceConnectionSecrets)
      .mockResolvedValueOnce(secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() }))
      .mockResolvedValueOnce(secrets({ accessToken: "at-winner", updatedAt: "2026-08-02T00:00:00Z" }));
    vi.mocked(refreshMicrosoftTokens).mockResolvedValue(rotated);
    vi.mocked(updateWorkspaceConnectionTokens).mockResolvedValue(false);

    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-winner");
  });

  it("falls back to its own token when the fence loses and the row vanished", async () => {
    vi.mocked(getWorkspaceConnectionSecrets)
      .mockResolvedValueOnce(secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() }))
      .mockResolvedValueOnce(null);
    vi.mocked(refreshMicrosoftTokens).mockResolvedValue(rotated);
    vi.mocked(updateWorkspaceConnectionTokens).mockResolvedValue(false);

    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-new");
  });

  it("falls back to its own token when the fence loses and the winner is inactive", async () => {
    vi.mocked(getWorkspaceConnectionSecrets)
      .mockResolvedValueOnce(secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() }))
      .mockResolvedValueOnce(secrets({ isActive: false }));
    vi.mocked(refreshMicrosoftTokens).mockResolvedValue(rotated);
    vi.mocked(updateWorkspaceConnectionTokens).mockResolvedValue(false);

    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-new");
  });

  describe("invalid_grant", () => {
    const dead = new MicrosoftOAuthError("invalid_grant", "grant is dead");

    beforeEach(() => {
      vi.mocked(refreshMicrosoftTokens).mockRejectedValue(dead);
    });

    it("deactivates the connection when the grant is genuinely revoked", async () => {
      vi.mocked(getWorkspaceConnectionSecrets)
        .mockResolvedValueOnce(secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() }))
        // Re-read shows the same row: nobody else rotated, so it really is dead.
        .mockResolvedValueOnce(secrets());

      await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBeNull();
      expect(setWorkspaceConnectionActive).toHaveBeenCalledWith(ROW_ID, false);
    });

    it("does NOT deactivate when another instance already rotated the token", async () => {
      // The in-process map cannot see other servers, so an invalid_grant here
      // may just mean we lost the race. Deactivating would take down a healthy
      // connection.
      vi.mocked(getWorkspaceConnectionSecrets)
        .mockResolvedValueOnce(secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() }))
        .mockResolvedValueOnce(
          secrets({ accessToken: "at-winner", updatedAt: "2026-08-05T00:00:00Z" })
        );

      await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-winner");
      expect(setWorkspaceConnectionActive).not.toHaveBeenCalled();
    });

    it("deactivates when the re-read row is gone", async () => {
      vi.mocked(getWorkspaceConnectionSecrets)
        .mockResolvedValueOnce(secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() }))
        .mockResolvedValueOnce(null);

      await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBeNull();
      expect(setWorkspaceConnectionActive).toHaveBeenCalledWith(ROW_ID, false);
    });

    it("deactivates when the re-read row is inactive", async () => {
      vi.mocked(getWorkspaceConnectionSecrets)
        .mockResolvedValueOnce(secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() }))
        .mockResolvedValueOnce(secrets({ isActive: false, updatedAt: "2026-08-09T00:00:00Z" }));

      await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBeNull();
      expect(setWorkspaceConnectionActive).toHaveBeenCalledWith(ROW_ID, false);
    });
  });

  it("propagates a transient refresh failure instead of deactivating", async () => {
    // A timeout is not evidence the grant is dead; swallowing it here would
    // disconnect every tenant during a Microsoft blip.
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() })
    );
    vi.mocked(refreshMicrosoftTokens).mockRejectedValue(
      new MicrosoftOAuthError("upstream_timeout", "timed out")
    );

    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).rejects.toThrow("timed out");
    expect(setWorkspaceConnectionActive).not.toHaveBeenCalled();
  });

  it("clears the single-flight entry after a failure so the next call retries", async () => {
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(
      secrets({ tokenExpiresAt: new Date(NOW - 1).toISOString() })
    );
    vi.mocked(refreshMicrosoftTokens)
      .mockRejectedValueOnce(new MicrosoftOAuthError("upstream_timeout", "blip"))
      .mockResolvedValueOnce(rotated);

    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).rejects.toThrow("blip");
    await expect(getMicrosoftAccessToken(ROW_ID, NOW)).resolves.toBe("at-new");
  });
});
