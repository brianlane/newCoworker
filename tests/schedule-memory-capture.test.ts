import { beforeEach, describe, expect, it, vi } from "vitest";

const afterMock = vi.fn();
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => afterMock(cb)
}));
vi.mock("@/lib/dashboard-chat/memory-capture", () => ({
  captureOwnerRuleInline: vi.fn(async () => ({ saved: [] }))
}));

import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { captureOwnerRuleInline } from "@/lib/dashboard-chat/memory-capture";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleCaptureOwnerRuleInline", () => {
  it("defers the capture via after() and does not run it synchronously", () => {
    scheduleCaptureOwnerRuleInline({ businessId: "biz-1", ownerMessage: "rule" });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(captureOwnerRuleInline).not.toHaveBeenCalled();
  });

  it("runs captureOwnerRuleInline with the args when the deferred callback fires", async () => {
    const args = { businessId: "biz-1", ownerMessage: "rule", assistantReply: "ok" };
    scheduleCaptureOwnerRuleInline(args);
    const cb = afterMock.mock.calls[0][0] as () => unknown;
    await cb();
    expect(captureOwnerRuleInline).toHaveBeenCalledWith(args);
  });
});
