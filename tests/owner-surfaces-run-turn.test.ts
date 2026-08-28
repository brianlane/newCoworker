import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared owner-surface turn runner.
 *
 * The channel suites (messenger-staff-turn, slack-worker) already drive this
 * end to end and own the "does the owner stop being pitched" assertions.
 * What lives HERE is the contract those two share and neither can assert
 * alone: that the verdict a caller gets back is honest about whether it can
 * be retried, that the surface's own configuration is what gets applied, and
 * that a caller which already read the business row is not made to pay for a
 * second read of it.
 */

vi.mock("@/lib/owner-surfaces/staff-mode", () => ({ staffModeEnabled: vi.fn() }));
vi.mock("@/lib/owner-surfaces/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/owner-surfaces/context")>()),
  loadOwnerSurfaceContext: vi.fn()
}));
vi.mock("@/lib/dashboard-chat/inline-turn", () => ({ runInlineChatTurn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import { loadOwnerSurfaceContext, type OwnerSurfaceContext } from "@/lib/owner-surfaces/context";
import { staffModeEnabled } from "@/lib/owner-surfaces/staff-mode";
import {
  runOwnerSurfaceTurn,
  type OwnerSurfaceTurnArgs
} from "@/lib/owner-surfaces/run-turn";

const BIZ = "00000000-0000-0000-0000-0000000000aa";

function context(overrides: Partial<OwnerSurfaceContext> = {}): OwnerSurfaceContext {
  return {
    timezone: null,
    tier: "standard" as OwnerSurfaceContext["tier"],
    ownerEmail: "owner@x.co",
    knowledgeToolEnabled: true,
    emailToolEnabled: true,
    toolStates: {
      send_sms: true,
      send_whatsapp: true,
      calendar_find_slots: true,
      calendar_book_appointment: true,
      calendar_reschedule_appointment: true,
      calendar_cancel_appointment: true,
      calendar_join_waitlist: true,
      run_aiflow: true,
      edit_aiflow: true,
      update_notification_preferences: true,
      flag_contact_spam: true,
      set_contact_reply_mode: true,
      manage_employee: true,
      custom_table_read: true,
      custom_table_write: true,
      custom_table_manage: true
    },
    whatsappConnected: true,
    integrationsLine: null,
    bookingLinkLine: null,
    businessContextBlock: null,
    bridgeExtraTools: null,
    overCap: false,
    ...overrides
  };
}

function args(overrides: Partial<OwnerSurfaceTurnArgs> = {}): OwnerSurfaceTurnArgs {
  return {
    businessId: BIZ,
    surfaceKey: "slack",
    speaker: { kind: "owner", name: "Amy", readFailed: false },
    speakerRef: "Amy",
    history: [{ role: "user", content: "how many leads today?" }],
    speakerLabel: "Amy",
    userLabel: "Slack from owner Amy",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(staffModeEnabled).mockResolvedValue(true);
  vi.mocked(loadOwnerSurfaceContext).mockResolvedValue(context());
  vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: true, content: "Four.", drafts: [] });
});

describe("the verdict is honest about retrying", () => {
  it("marks a model failure retryable, so the queue tries again", async () => {
    vi.mocked(runInlineChatTurn).mockResolvedValue({
      ok: false,
      error: "model_failed",
      detail: "upstream 503"
    });
    const out = await runOwnerSurfaceTurn(args());
    expect(out).toEqual({
      kind: "failed",
      detail: "upstream 503",
      code: "model_failed"
    });
    // No `terminal`, so the caller's retry ladder owns it.
    expect(out).not.toHaveProperty("terminal", true);
  });

  it("carries the engine's own error code when it gave no detail", async () => {
    // detail is the free text a human reads; code is what lands in the job
    // row. An engine that reports one without the other must not lose the
    // one it did report.
    vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: false, error: "empty" });
    const out = await runOwnerSurfaceTurn(args());
    expect(out).toEqual({ kind: "failed", detail: "empty", code: "empty" });
  });

  it("marks nothing-to-answer TERMINAL, so it cannot burn three attempts", async () => {
    const out = await runOwnerSurfaceTurn(
      args({ history: [{ role: "assistant", content: "already answered" }] })
    );
    expect(out).toEqual({
      kind: "failed",
      detail: "no_input",
      code: "no_input",
      terminal: true
    });
    expect(runInlineChatTurn).not.toHaveBeenCalled();
  });

  it("treats an empty history as nothing to answer rather than crashing", async () => {
    const out = await runOwnerSurfaceTurn(args({ history: [] }));
    expect(out).toMatchObject({ kind: "failed", code: "no_input", terminal: true });
  });

  it("keeps over-cap out of the failure taxonomy entirely", async () => {
    // Its own case on purpose: Slack owes the speaker a line here and
    // WhatsApp owes them silence, and a caller cannot tell those apart from
    // a generic `failed`.
    vi.mocked(loadOwnerSurfaceContext).mockResolvedValue(context({ overCap: true }));
    expect(await runOwnerSurfaceTurn(args())).toEqual({ kind: "over_cap" });
    expect(runInlineChatTurn).not.toHaveBeenCalled();
  });
});

describe("staff mode is asked first, and asked about the right surface", () => {
  it("returns silent before spending a single context read", async () => {
    vi.mocked(staffModeEnabled).mockResolvedValue(false);
    const out = await runOwnerSurfaceTurn(args());
    expect(out).toEqual({ kind: "silent", reason: "staff_mode_off" });
    // The point of asking first: a switched-off surface costs nothing.
    expect(loadOwnerSurfaceContext).not.toHaveBeenCalled();
    expect(runInlineChatTurn).not.toHaveBeenCalled();
  });

  it.each(["sms", "slack", "whatsapp"] as const)(
    "asks about %s when that is the surface running",
    async (surfaceKey) => {
      await runOwnerSurfaceTurn(args({ surfaceKey }));
      expect(staffModeEnabled).toHaveBeenCalledWith(BIZ, surfaceKey);
    }
  );
});

describe("the surface's own configuration is what gets applied", () => {
  it("clips to the surface limit and keeps the pre-clip answer alongside", async () => {
    // SMS and Slack both fulfil EMAIL_SEND blocks before clipping, because
    // clipping first can cut a block into an unparseable fragment that then
    // reaches the owner verbatim.
    vi.mocked(runInlineChatTurn).mockResolvedValue({
      ok: true,
      content: "y".repeat(5000),
      drafts: []
    });
    const out = await runOwnerSurfaceTurn(args({ surfaceKey: "sms" }));
    expect(out).toMatchObject({ kind: "reply" });
    if (out.kind !== "reply") throw new Error("expected a reply");
    expect(out.reply.length).toBe(1200);
    expect(out.unclipped.length).toBe(5000);
  });

  it("stamps the surface's flow-edit provenance and budget", async () => {
    await runOwnerSurfaceTurn(args({ surfaceKey: "whatsapp" }));
    const turn = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(turn.flowEditSource).toBe("ai_edit_whatsapp");
    expect(turn.flowEditSurfaceKind).toBe("text");
    expect(turn.includeCreationTools).toBe(false);
  });

  it("files flow edits against the speaker's channel identity", async () => {
    await runOwnerSurfaceTurn(args({ speakerRef: "+15145188192" }));
    expect(vi.mocked(runInlineChatTurn).mock.calls[0][0].flowEditActor).toBe("+15145188192");
  });

  it("passes a streaming callback through untouched for the surfaces that have one", async () => {
    const onTextDelta = vi.fn();
    await runOwnerSurfaceTurn(args({ onTextDelta }));
    vi.mocked(runInlineChatTurn).mock.calls[0][0].onTextDelta?.("partial");
    expect(onTextDelta).toHaveBeenCalledWith("partial");
  });
});

describe("what the model is shown", () => {
  it("answers the last message and replays only what came before it", async () => {
    await runOwnerSurfaceTurn(
      args({
        history: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second question" }
        ]
      })
    );
    const turn = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(turn.userMessage).toBe("[Slack from owner Amy] second question");
    expect(turn.systemInstruction).toContain("[Amy]: first question");
    expect(turn.systemInstruction).toContain("[Coworker]: first answer");
    // Showing the answered message twice teaches the model it was asked twice.
    expect(turn.systemInstruction).not.toContain("second question");
  });

  it("truncates a replayed line rather than letting one message eat the window", async () => {
    await runOwnerSurfaceTurn(
      args({
        history: [
          { role: "user", content: "z".repeat(2000) },
          { role: "user", content: "and now?" }
        ]
      })
    );
    const sys = vi.mocked(runInlineChatTurn).mock.calls[0][0].systemInstruction;
    expect(sys).toContain(`[Amy]: ${"z".repeat(500)}`);
    expect(sys).not.toContain("z".repeat(501));
  });
});

describe("context loading", () => {
  it("hands over a business row the caller already read, instead of re-reading it", async () => {
    // Slack reads `businesses` for the owner's UI locale before the turn
    // starts. Without this the context load would read the same row again
    // on every single message.
    const businessMeta = { timezone: "America/Toronto", tier: "enterprise" as const, ownerEmail: "amy@x.co" };
    await runOwnerSurfaceTurn(args({ businessMeta, bridgeUserId: "slack:U123" }));
    const opts = vi.mocked(loadOwnerSurfaceContext).mock.calls[0][4];
    expect(opts).toEqual({ bridgeUserId: "slack:U123", meta: businessMeta });
  });

  it("reports an unreadable context instead of answering without it", async () => {
    vi.mocked(loadOwnerSurfaceContext).mockRejectedValue(new Error("settings unreadable"));
    expect(await runOwnerSurfaceTurn(args())).toEqual({
      kind: "failed",
      detail: "settings unreadable",
      code: "context_load_failed"
    });
  });

  it("survives a rejection that is not an Error", async () => {
    vi.mocked(loadOwnerSurfaceContext).mockRejectedValue("connection reset");
    expect(await runOwnerSurfaceTurn(args())).toEqual({
      kind: "failed",
      detail: "connection reset",
      code: "context_load_failed"
    });
  });
});
