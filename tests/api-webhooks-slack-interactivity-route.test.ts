/**
 * The Slack interactivity receiver (approval buttons). Signature checks run
 * against REAL HMACs over the form-encoded body; identity is verified fresh
 * per press; card rewrites and refusals ride response_url via after().
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const afterCallbacks: Array<() => Promise<void> | void> = [];
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (cb: () => Promise<void> | void) => {
      afterCallbacks.push(cb);
    }
  };
});
vi.mock("@/lib/db/slack-connections", () => ({ getSlackConnectionByTeamId: vi.fn() }));
vi.mock("@/lib/slack/client", () => ({ slackUsersInfo: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/slack/approvals", async () => {
  const actual = await vi.importActual<typeof import("@/lib/slack/approvals")>(
    "@/lib/slack/approvals"
  );
  return { slackApprovalAck: actual.slackApprovalAck, applySlackApprovalDecision: vi.fn() };
});
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { POST } from "@/app/api/webhooks/slack/interactivity/route";
import { getSlackConnectionByTeamId } from "@/lib/db/slack-connections";
import { slackUsersInfo } from "@/lib/slack/client";
import { getBusiness } from "@/lib/db/businesses";
import { applySlackApprovalDecision } from "@/lib/slack/approvals";

const SECRET = "signing-secret-abc";
const BIZ = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

function payloadBody(overrides: Record<string, unknown> = {}) {
  const payload = {
    type: "block_actions",
    team: { id: "T-1" },
    user: { id: "U-1", name: "amy" },
    actions: [
      {
        action_id: "aiflow_approval:approve",
        value: JSON.stringify({ r: RUN, o: "approve" })
      }
    ],
    response_url: "https://hooks.slack.com/actions/resp-1",
    ...overrides
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function signedRequest(rawBody: string, opts?: { signature?: string }) {
  const ts = Math.floor(Date.now() / 1000);
  const signature =
    opts?.signature ??
    `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  return new Request("https://x/api/webhooks/slack/interactivity", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": signature,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: rawBody
  });
}

async function drainAfter() {
  for (const cb of afterCallbacks.splice(0)) await cb();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
  vi.mocked(getSlackConnectionByTeamId).mockResolvedValue({
    business_id: BIZ,
    is_active: true,
    botToken: "xoxb-1"
  } as never);
  vi.mocked(slackUsersInfo).mockResolvedValue({
    displayName: "Amy",
    email: "owner@x.co",
    isBot: false
  });
  vi.mocked(getBusiness).mockResolvedValue({ owner_email: "Owner@X.co" } as never);
  vi.mocked(applySlackApprovalDecision).mockResolvedValue({
    applied: true,
    kind: "decision",
    option: "approve"
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/webhooks/slack/interactivity", () => {
  it("refuses unsigned deliveries and ignores non-approval payloads", async () => {
    const unsigned = new Request("https://x/api/webhooks/slack/interactivity", {
      method: "POST",
      body: payloadBody()
    });
    expect((await POST(unsigned)).status).toBe(401);

    const other = await POST(
      signedRequest(payloadBody({ actions: [{ action_id: "something_else", value: "x" }] }))
    );
    expect(await other.json()).toMatchObject({ data: { ignored: true } });

    const badValue = await POST(
      signedRequest(payloadBody({ actions: [{ action_id: "aiflow_approval:approve", value: "{" }] }))
    );
    expect(await badValue.json()).toMatchObject({ data: { ignored: true } });
    expect(vi.mocked(applySlackApprovalDecision)).not.toHaveBeenCalled();
  });

  it("413s oversized bodies and ignores unknown workspaces", async () => {
    expect((await POST(signedRequest("x".repeat(262145)))).status).toBe(413);

    vi.mocked(getSlackConnectionByTeamId).mockResolvedValue(null);
    const res = await POST(signedRequest(payloadBody()));
    expect(await res.json()).toMatchObject({ data: { ignored: true } });
  });

  it("applies an owner press and rewrites the card via response_url", async () => {
    const res = await POST(signedRequest(payloadBody()));
    expect(await res.json()).toMatchObject({ data: { applied: true } });
    expect(vi.mocked(applySlackApprovalDecision)).toHaveBeenCalledWith({
      businessId: BIZ,
      runId: RUN,
      option: "approve",
      decidedBy: "slack:U-1"
    });
    await drainAfter();
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/actions/resp-1");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.replace_original).toBe(true);
    expect(body.text).toContain("✅ Approved, sending it now");
    expect(body.text).toContain("(amy)");
  });

  it("shows the stop emoji for cancel and an ephemeral note for a raced press", async () => {
    vi.mocked(applySlackApprovalDecision).mockResolvedValue({
      applied: true,
      kind: "decision",
      option: "cancel"
    });
    await POST(signedRequest(payloadBody()));
    await drainAfter();
    let body = JSON.parse(
      String((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body)
    ) as Record<string, unknown>;
    expect(body.text).toContain("🛑");

    vi.mocked(fetch).mockClear();
    vi.mocked(applySlackApprovalDecision).mockResolvedValue({
      applied: false,
      reason: "already_handled"
    });
    await POST(signedRequest(payloadBody()));
    await drainAfter();
    body = JSON.parse(
      String((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body)
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ response_type: "ephemeral", replace_original: false });
  });

  it("refuses a non-owner with an ephemeral note and never decides", async () => {
    vi.mocked(slackUsersInfo).mockResolvedValue({
      displayName: "Dave",
      email: "dave@x.co",
      isBot: false
    });
    const res = await POST(signedRequest(payloadBody()));
    expect(await res.json()).toMatchObject({ data: { refused: "not_owner" } });
    expect(vi.mocked(applySlackApprovalDecision)).not.toHaveBeenCalled();
    await drainAfter();
    const body = JSON.parse(
      String((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body)
    ) as Record<string, unknown>;
    expect(body.text).toContain("Only the business owner");
  });

  it("degrades a thrown decision to an ephemeral retry note, and survives a dead response_url", async () => {
    vi.mocked(applySlackApprovalDecision).mockRejectedValue(new Error("db down"));
    const res = await POST(signedRequest(payloadBody()));
    expect(await res.json()).toMatchObject({ data: { error: "decision_failed" } });
    await drainAfter();

    vi.mocked(applySlackApprovalDecision).mockResolvedValue({
      applied: true,
      kind: "decision",
      option: "approve"
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("hook down"))));
    await POST(signedRequest(payloadBody()));
    await expect(drainAfter()).resolves.toBeUndefined();

    // A payload with no response_url skips the post entirely.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
    await POST(signedRequest(payloadBody({ response_url: undefined })));
    await drainAfter();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
