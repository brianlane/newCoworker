/**
 * scheduleLongFormGraphExtract defers the chunked extraction through
 * next/server's after() — the same keep-alive contract as
 * scheduleVaultSync — and forwards its arguments unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const afterMock = vi.fn();
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => afterMock(cb)
}));
vi.mock("@/lib/memory/graph-longform", () => ({
  extractLongFormGraph: vi.fn(async () => ({ ran: true }))
}));

import { scheduleLongFormGraphExtract } from "@/lib/memory/schedule-longform-extract";
import { extractLongFormGraph } from "@/lib/memory/graph-longform";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleLongFormGraphExtract", () => {
  it("defers via after() and does not extract synchronously", () => {
    scheduleLongFormGraphExtract("biz-1", {
      text: "doc body",
      source: "document",
      attributedTo: "Quote"
    });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(extractLongFormGraph).not.toHaveBeenCalled();
  });

  it("runs the extraction with the args when the deferred callback fires", async () => {
    scheduleLongFormGraphExtract("biz-1", {
      text: "site body",
      source: "website",
      attributedTo: "https://x.example"
    });
    const cb = afterMock.mock.calls[0][0] as () => unknown;
    await cb();
    expect(extractLongFormGraph).toHaveBeenCalledWith("biz-1", {
      text: "site body",
      source: "website",
      attributedTo: "https://x.example"
    });
  });
});
