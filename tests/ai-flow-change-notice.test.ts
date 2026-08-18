import { describe, expect, it, vi } from "vitest";
import {
  announceFlowChange,
  shouldAnnounceFlowChange
} from "@/lib/ai-flows/change-notice";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { logger } from "@/lib/logger";

const BASE = {
  businessId: "biz-1",
  flowId: "flow-1",
  flowName: "Lead follow-up",
  action: "edited" as const
};

function deps() {
  return {
    dispatch: vi.fn(async (_input: Record<string, unknown>) => ({}) as never),
    log: vi.fn(async (_input: Record<string, unknown>) => {})
  };
}

describe("shouldAnnounceFlowChange", () => {
  it("announces every AI surface", () => {
    for (const s of [
      "ai_edit_sms",
      "ai_edit_email",
      "ai_edit_slack",
      "ai_edit_dashboard",
      "mcp",
      "mcp_restore"
    ]) {
      expect(shouldAnnounceFlowChange(s)).toBe(true);
    }
  });

  it("stays quiet for the owner's own dashboard edit and for white glove", () => {
    // The owner is looking at the automation when they edit it there, and an
    // alert for a change you just watched yourself make teaches people to
    // ignore alerts.
    expect(shouldAnnounceFlowChange("dashboard")).toBe(false);
    expect(shouldAnnounceFlowChange("white_glove")).toBe(false);
    expect(shouldAnnounceFlowChange("oneshot")).toBe(false);
    expect(shouldAnnounceFlowChange(undefined)).toBe(false);
  });
});

describe("announceFlowChange", () => {
  it("does nothing at all for an unannounced source", async () => {
    const d = deps();
    await announceFlowChange({ ...BASE, source: "dashboard" }, d);
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it("leaves both traces: a system log and an owner alert", async () => {
    const d = deps();
    await announceFlowChange(
      { ...BASE, source: "ai_edit_sms", actor: "+15555550100", summary: ["a line"] },
      d
    );
    expect(d.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "aiflow_changed_by_ai",
        payload: expect.objectContaining({
          flow_id: "flow-1",
          edit_source: "ai_edit_sms",
          edit_actor: "+15555550100",
          change_summary: ["a line"]
        })
      })
    );
    expect(d.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "aiflow_changed_by_ai",
        ctaPath: "/dashboard/aiflows?edit=flow-1"
      })
    );
  });

  it("names the surface, so the owner knows where it came from", async () => {
    const cases: Array<[string, string]> = [
      ["ai_edit_sms", "by text"],
      ["ai_edit_email", "by email"],
      ["ai_edit_slack", "in Slack"],
      ["ai_edit_dashboard", "in dashboard chat"],
      ["mcp", "through a connected app"],
      ["mcp_restore", "through a connected app"]
    ];
    for (const [source, label] of cases) {
      const d = deps();
      await announceFlowChange({ ...BASE, source }, d);
      expect(d.dispatch.mock.calls[0][0].summary).toContain(label);
    }
  });

  it("says 'put back' for an undo and 'changed' for an edit", async () => {
    const edited = deps();
    await announceFlowChange({ ...BASE, source: "ai_edit_sms" }, edited);
    expect(edited.dispatch.mock.calls[0][0].summary).toContain("was changed");

    const reverted = deps();
    await announceFlowChange({ ...BASE, action: "reverted", source: "ai_edit_sms" }, reverted);
    expect(reverted.dispatch.mock.calls[0][0].summary).toContain("was put back");
    expect(reverted.dispatch.mock.calls[0][0].emailSubject).toContain("Automation put back");
  });

  it("tells the owner the one thing that undoes it", async () => {
    const d = deps();
    await announceFlowChange({ ...BASE, source: "ai_edit_sms" }, d);
    expect(d.dispatch.mock.calls[0][0].smsBody).toContain('"undo that"');
  });

  it("omits change_summary rather than writing an empty one", async () => {
    const d = deps();
    await announceFlowChange({ ...BASE, source: "mcp", summary: [] }, d);
    expect(d.log.mock.calls[0][0].payload).not.toHaveProperty("change_summary");
    const d2 = deps();
    await announceFlowChange({ ...BASE, source: "mcp" }, d2);
    expect(d2.log.mock.calls[0][0].payload).not.toHaveProperty("change_summary");
  });

  it("a failed log still lets the alert go out", async () => {
    // The change already landed; neither trace failing may hide it.
    const d = deps();
    d.log = vi.fn(async () => {
      throw new Error("log down");
    });
    await expect(
      announceFlowChange({ ...BASE, source: "ai_edit_sms" }, d)
    ).resolves.toBeUndefined();
    expect(d.dispatch).toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "announceFlowChange: system log failed",
      expect.objectContaining({ error: "log down" })
    );

    // Non-Error throw: still reported, still lets the alert through.
    const d2 = deps();
    d2.log = vi.fn(async () => {
      throw "log exploded";
    });
    await announceFlowChange({ ...BASE, source: "ai_edit_sms" }, d2);
    expect(d2.dispatch).toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "announceFlowChange: system log failed",
      expect.objectContaining({ error: "log exploded" })
    );
  });

  it("a failed alert never surfaces as a failed change", async () => {
    const d = deps();
    d.dispatch = vi.fn(async () => {
      throw "sms down";
    });
    await expect(
      announceFlowChange({ ...BASE, source: "ai_edit_sms" }, d)
    ).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "announceFlowChange: dispatch failed",
      expect.objectContaining({ error: "sms down" })
    );

    const d2 = deps();
    d2.dispatch = vi.fn(async () => {
      throw new Error("provider 500");
    });
    await expect(
      announceFlowChange({ ...BASE, source: "ai_edit_sms" }, d2)
    ).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "announceFlowChange: dispatch failed",
      expect.objectContaining({ error: "provider 500" })
    );
  });

  it("records a null actor rather than omitting it", async () => {
    const d = deps();
    await announceFlowChange({ ...BASE, source: "mcp" }, d);
    expect(d.log.mock.calls[0][0].payload).toMatchObject({ edit_actor: null });
  });
});
