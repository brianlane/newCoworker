/**
 * The Slack connection management route (/api/integrations/slack).
 *
 * The behavior worth pinning is the alert-channel contract: the channel is
 * stored ONLY after a hello post proves the bot can deliver there, and a
 * bot that isn't in a private channel yet gets an actionable "invite the
 * bot" message instead of a stored-but-dead channel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));
vi.mock("@/lib/db/slack-connections", () => ({
  deleteSlackConnection: vi.fn(),
  getActiveSlackConnection: vi.fn(),
  getPublicSlackConnection: vi.fn(),
  getSlackConnection: vi.fn(),
  setSlackAlertChannel: vi.fn(),
  setSlackConnectionActive: vi.fn()
}));
vi.mock("@/lib/slack/oauth", () => ({ revokeSlackToken: vi.fn() }));
vi.mock("@/lib/slack/client", () => ({
  slackListChannels: vi.fn(),
  slackPostMessage: vi.fn()
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: vi.fn(() => ({ value: "es" })) }))
}));

import { DELETE, GET, PATCH } from "@/app/api/integrations/slack/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  deleteSlackConnection,
  getActiveSlackConnection,
  getPublicSlackConnection,
  getSlackConnection,
  setSlackAlertChannel,
  setSlackConnectionActive
} from "@/lib/db/slack-connections";
import { revokeSlackToken } from "@/lib/slack/oauth";
import { slackListChannels, slackPostMessage } from "@/lib/slack/client";

const BIZ = "11111111-1111-4111-8111-111111111111";

const PUBLIC_ROW = {
  id: "sc-1",
  business_id: BIZ,
  team_id: "T-1",
  team_name: "Acme",
  enterprise_id: null,
  bot_user_id: "U-BOT",
  app_id: "A-1",
  scopes: "chat:write",
  alert_channel_id: null,
  alert_channel_name: null,
  is_active: true,
  installed_by_user_id: "user-1",
  has_bot_token: true,
  created_at: "",
  updated_at: ""
};

function bodyReq(method: string, body: unknown) {
  return new Request("https://x/api/integrations/slack", {
    method,
    body: JSON.stringify(body)
  });
}

async function json(res: Response) {
  return (await res.json()) as {
    data?: Record<string, unknown> | null;
    error?: { message?: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({ email: "o@x.co", isAdmin: false } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(getPublicSlackConnection).mockResolvedValue(PUBLIC_ROW as never);
  vi.mocked(getSlackConnection).mockResolvedValue({
    ...PUBLIC_ROW,
    botToken: "xoxb-1"
  } as never);
  vi.mocked(getActiveSlackConnection).mockResolvedValue({
    ...PUBLIC_ROW,
    botToken: "xoxb-1"
  } as never);
  vi.mocked(slackListChannels).mockResolvedValue([
    { id: "C-1", name: "general", is_private: false, is_member: true }
  ]);
  vi.mocked(slackPostMessage).mockResolvedValue({ ok: true, ts: "1.2", channel: "C-1" });
  vi.mocked(revokeSlackToken).mockResolvedValue(true);
});

describe("GET", () => {
  const getReq = (biz?: string) =>
    new Request(`https://x/api/integrations/slack${biz ? `?businessId=${biz}` : ""}`);

  it("requires a businessId and an authenticated caller", async () => {
    expect((await json(await GET(getReq()))).error?.message).toMatch(/businessId/);
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await json(await GET(getReq(BIZ)))).error?.message).toMatch(/Authentication/);
  });

  it("returns the masked connection plus the channel list", async () => {
    const data = (await json(await GET(getReq(BIZ)))).data as {
      connection: typeof PUBLIC_ROW;
      channels: unknown[];
    };
    expect(data.connection.team_id).toBe("T-1");
    expect(data.channels).toHaveLength(1);
  });

  it("degrades the channel list to empty on a Slack hiccup or wiped token", async () => {
    vi.mocked(slackListChannels).mockRejectedValue(new Error("slack down"));
    let data = (await json(await GET(getReq(BIZ)))).data as { channels: unknown[] };
    expect(data.channels).toEqual([]);

    vi.mocked(getPublicSlackConnection).mockResolvedValue({
      ...PUBLIC_ROW,
      has_bot_token: false
    } as never);
    data = (await json(await GET(getReq(BIZ)))).data as { channels: unknown[] };
    expect(data.channels).toEqual([]);
    expect(vi.mocked(getSlackConnection)).toHaveBeenCalledTimes(1);
  });

  it("returns a null connection when nothing is linked", async () => {
    vi.mocked(getPublicSlackConnection).mockResolvedValue(null);
    const data = (await json(await GET(getReq(BIZ)))).data as { connection: unknown };
    expect(data.connection).toBeNull();
  });
});

describe("PATCH", () => {
  it("validates the body shape", async () => {
    const res = await PATCH(bodyReq("PATCH", { businessId: BIZ }));
    expect(res.status).not.toBe(200);
  });

  it("refuses when unauthenticated or not connected", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect(
      (await json(await PATCH(bodyReq("PATCH", { businessId: BIZ, isActive: false })))).error
        ?.message
    ).toMatch(/Authentication/);

    vi.mocked(getAuthUser).mockResolvedValue({ email: "o@x.co", isAdmin: false } as never);
    vi.mocked(getPublicSlackConnection).mockResolvedValue(null);
    expect(
      (await json(await PATCH(bodyReq("PATCH", { businessId: BIZ, isActive: false })))).error
        ?.message
    ).toMatch(/No Slack connection/);
  });

  it("flips is_active", async () => {
    await PATCH(bodyReq("PATCH", { businessId: BIZ, isActive: false }));
    expect(vi.mocked(setSlackConnectionActive)).toHaveBeenCalledWith(BIZ, false);
  });

  it("stores the alert channel only after the hello post succeeds", async () => {
    await PATCH(
      bodyReq("PATCH", { businessId: BIZ, alertChannel: { id: "C-1", name: "general" } })
    );
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ channel: "C-1" })
    );
    expect(vi.mocked(setSlackAlertChannel)).toHaveBeenCalledWith(BIZ, {
      id: "C-1",
      name: "general"
    });
  });

  it("asks for an invite when the bot can't post, and stores nothing", async () => {
    vi.mocked(slackPostMessage).mockResolvedValue({ ok: false, error: "not_in_channel" });
    const res = await PATCH(
      bodyReq("PATCH", { businessId: BIZ, alertChannel: { id: "C-9", name: "private" } })
    );
    expect((await json(res)).error?.message).toMatch(/invite @New Coworker/);
    expect(vi.mocked(setSlackAlertChannel)).not.toHaveBeenCalled();
  });

  it("names other Slack refusals plainly", async () => {
    vi.mocked(slackPostMessage).mockResolvedValue({ ok: false, error: "restricted_action" });
    const res = await PATCH(
      bodyReq("PATCH", { businessId: BIZ, alertChannel: { id: "C-1", name: "general" } })
    );
    expect((await json(res)).error?.message).toMatch(/restricted_action/);
  });

  it("refuses to pick a channel on an inactive connection", async () => {
    vi.mocked(getActiveSlackConnection).mockResolvedValue(null);
    const res = await PATCH(
      bodyReq("PATCH", { businessId: BIZ, alertChannel: { id: "C-1", name: "general" } })
    );
    expect((await json(res)).error?.message).toMatch(/Reconnect Slack/);
  });

  it("clears the channel with alertChannel: null", async () => {
    await PATCH(bodyReq("PATCH", { businessId: BIZ, alertChannel: null }));
    expect(vi.mocked(setSlackAlertChannel)).toHaveBeenCalledWith(BIZ, null);
    expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled();
  });
});

describe("DELETE", () => {
  it("revokes best-effort then deletes", async () => {
    await DELETE(bodyReq("DELETE", { businessId: BIZ }));
    expect(vi.mocked(revokeSlackToken)).toHaveBeenCalledWith("xoxb-1");
    expect(vi.mocked(deleteSlackConnection)).toHaveBeenCalledWith(BIZ);
  });

  it("still deletes when the token read fails or the token is wiped", async () => {
    vi.mocked(getSlackConnection).mockRejectedValue(new Error("read broke"));
    await DELETE(bodyReq("DELETE", { businessId: BIZ }));
    expect(vi.mocked(revokeSlackToken)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteSlackConnection)).toHaveBeenCalledWith(BIZ);

    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({ email: "o@x.co", isAdmin: false } as never);
    vi.mocked(getSlackConnection).mockResolvedValue({
      ...PUBLIC_ROW,
      botToken: ""
    } as never);
    await DELETE(bodyReq("DELETE", { businessId: BIZ }));
    expect(vi.mocked(revokeSlackToken)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteSlackConnection)).toHaveBeenCalledWith(BIZ);
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await DELETE(bodyReq("DELETE", { businessId: BIZ }));
    expect((await json(res)).error?.message).toMatch(/Authentication/);
    expect(vi.mocked(deleteSlackConnection)).not.toHaveBeenCalled();
  });
});
