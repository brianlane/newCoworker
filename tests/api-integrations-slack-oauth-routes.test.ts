/**
 * The Slack connect + callback routes, which are the only way a
 * `slack_connections` row comes into existence.
 *
 * Worth pinning: the connect route enforces auth, role, AND the Standard+
 * tier BEFORE handing the browser to Slack; the callback re-verifies the
 * signed state and the session (two-factor), maps a dead code to a
 * banner instead of a 500, and surfaces "workspace already linked to
 * another business" in plain words.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));
vi.mock("@/lib/slack/tier-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/slack/tier-gate")>(
    "@/lib/slack/tier-gate"
  );
  return { SLACK_UPGRADE_MESSAGE: actual.SLACK_UPGRADE_MESSAGE, slackAllowedForBusiness: vi.fn() };
});
vi.mock("@/lib/slack/oauth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/slack/oauth")>("@/lib/slack/oauth");
  return {
    SlackOAuthError: actual.SlackOAuthError,
    buildSlackAuthorizeUrl: vi.fn(() => "https://slack.com/oauth/v2/authorize?x=1"),
    createSlackOAuthState: vi.fn(() => "signed-state"),
    verifySlackOAuthState: vi.fn(),
    exchangeSlackAuthCode: vi.fn()
  };
});
vi.mock("@/lib/db/slack-connections", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/slack-connections")>(
    "@/lib/db/slack-connections"
  );
  return {
    SlackWorkspaceAlreadyLinkedError: actual.SlackWorkspaceAlreadyLinkedError,
    upsertSlackConnection: vi.fn()
  };
});
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { GET as connectGET } from "@/app/api/integrations/slack/connect/route";
import { GET as callbackGET } from "@/app/api/integrations/slack/callback/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { slackAllowedForBusiness } from "@/lib/slack/tier-gate";
import {
  createSlackOAuthState,
  exchangeSlackAuthCode,
  SlackOAuthError,
  verifySlackOAuthState
} from "@/lib/slack/oauth";
import {
  SlackWorkspaceAlreadyLinkedError,
  upsertSlackConnection
} from "@/lib/db/slack-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";

const INSTALL = {
  accessToken: "xoxb-1",
  teamId: "T-1",
  teamName: "Acme",
  enterpriseId: null,
  botUserId: "U-BOT",
  appId: "A-1",
  scopes: "chat:write"
};

function redirectedTo(res: Response): URL {
  expect([302, 307]).toContain(res.status);
  return new URL(res.headers.get("location")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    email: "o@x.co",
    userId: "user-1",
    isAdmin: false
  } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(slackAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(verifySlackOAuthState).mockReturnValue({ businessId: BIZ });
  vi.mocked(exchangeSlackAuthCode).mockResolvedValue(INSTALL);
  vi.mocked(upsertSlackConnection).mockResolvedValue({ id: "sc-1" } as never);
});

describe("connect", () => {
  const url = (biz?: string) =>
    new Request(`https://x/api/integrations/slack/connect${biz ? `?businessId=${biz}` : ""}`);

  it("302s to the Slack authorize URL with a state bound to the business", async () => {
    const res = await connectGET(url(BIZ));
    expect(redirectedTo(res).origin).toBe("https://slack.com");
    expect(vi.mocked(createSlackOAuthState)).toHaveBeenCalledWith(BIZ);
  });

  it("banners when the businessId is missing", async () => {
    const dest = redirectedTo(await connectGET(url()));
    expect(dest.pathname).toBe("/dashboard/integrations/slack");
    expect(dest.searchParams.get("error")).toMatch(/business is required/);
  });

  it("sends an unauthenticated browser to login", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const dest = redirectedTo(await connectGET(url(BIZ)));
    expect(dest.pathname).toBe("/login");
  });

  it("banners a role refusal as a permission error", async () => {
    vi.mocked(requireBusinessRole).mockRejectedValue(
      Object.assign(new Error("forbidden"), { status: 403 })
    );
    const dest = redirectedTo(await connectGET(url(BIZ)));
    expect(dest.searchParams.get("error")).toMatch(/permission/);
  });

  it("banners the upgrade message for a starter tenant", async () => {
    vi.mocked(slackAllowedForBusiness).mockResolvedValue(false);
    const dest = redirectedTo(await connectGET(url(BIZ)));
    expect(dest.searchParams.get("error")).toMatch(/Standard and Enterprise/);
  });

  it("admins skip the role check but not the tier gate", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "a@x.co", isAdmin: true } as never);
    await connectGET(url(BIZ));
    expect(vi.mocked(requireBusinessRole)).not.toHaveBeenCalled();
    expect(vi.mocked(slackAllowedForBusiness)).toHaveBeenCalledWith(BIZ);
  });

  it("banners not_configured and generic failures instead of 500ing", async () => {
    vi.mocked(createSlackOAuthState).mockImplementation(() => {
      throw new SlackOAuthError("not_configured", "no env");
    });
    expect(
      redirectedTo(await connectGET(url(BIZ))).searchParams.get("error")
    ).toMatch(/not configured/);

    vi.mocked(createSlackOAuthState).mockImplementation(() => {
      throw new Error("boom");
    });
    expect(
      redirectedTo(await connectGET(url(BIZ))).searchParams.get("error")
    ).toMatch(/Could not start/);
  });
});

describe("callback", () => {
  const url = (params: Record<string, string>) => {
    const u = new URL("https://x/api/integrations/slack/callback");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return new Request(u);
  };

  it("stores the install and lands on the card with workspace=connected", async () => {
    const dest = redirectedTo(await callbackGET(url({ code: "c-1", state: "s-1" })));
    expect(dest.pathname).toBe("/dashboard/integrations/slack");
    expect(dest.searchParams.get("workspace")).toBe("connected");
    expect(vi.mocked(upsertSlackConnection)).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        teamId: "T-1",
        botToken: "xoxb-1",
        installedByUserId: "user-1"
      })
    );
  });

  it("treats a missing code/state as the owner cancelling", async () => {
    const dest = redirectedTo(await callbackGET(url({ state: "s-1" })));
    expect(dest.searchParams.get("error")).toMatch(/cancelled/);
  });

  it("banners an unverifiable state as expired", async () => {
    vi.mocked(verifySlackOAuthState).mockReturnValue(null);
    const dest = redirectedTo(await callbackGET(url({ code: "c", state: "bad" })));
    expect(dest.searchParams.get("error")).toMatch(/expired/);
  });

  it("preserves code+state through a sign-in round-trip", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const dest = redirectedTo(await callbackGET(url({ code: "c-1", state: "s-1" })));
    expect(dest.pathname).toBe("/login");
    expect(decodeURIComponent(dest.searchParams.get("redirectTo")!)).toContain("code=c-1");
  });

  it("says so when the workspace already belongs to another business", async () => {
    vi.mocked(upsertSlackConnection).mockRejectedValue(new SlackWorkspaceAlreadyLinkedError());
    const dest = redirectedTo(await callbackGET(url({ code: "c", state: "s" })));
    expect(dest.searchParams.get("error")).toMatch(/already connected to a different business/);
  });

  it("maps a dead grant vs other OAuth failures to distinct banners", async () => {
    vi.mocked(exchangeSlackAuthCode).mockRejectedValue(
      new SlackOAuthError("invalid_grant", "dead code")
    );
    expect(
      redirectedTo(await callbackGET(url({ code: "c", state: "s" }))).searchParams.get("error")
    ).toMatch(/rejected the authorization/);

    vi.mocked(exchangeSlackAuthCode).mockRejectedValue(
      new SlackOAuthError("request_failed", "hiccup")
    );
    expect(
      redirectedTo(await callbackGET(url({ code: "c", state: "s" }))).searchParams.get("error")
    ).toMatch(/try again/);
  });

  it("banners unexpected errors without leaking them", async () => {
    vi.mocked(upsertSlackConnection).mockRejectedValue(new Error("db down"));
    const dest = redirectedTo(await callbackGET(url({ code: "c", state: "s" })));
    expect(dest.searchParams.get("error")).toBe("Slack connection failed");
  });
});
