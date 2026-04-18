import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("child_process")>();
  return { ...cp, spawnSync: spawnSyncMock };
});

import { quoteShellEnvValue } from "@/lib/provisioning/orchestrate";

describe("quoteShellEnvValue", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("uses printf %q output when bash succeeds", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "quoted\n" });
    expect(quoteShellEnvValue("hello")).toBe("quoted");
    expect(spawnSyncMock).toHaveBeenCalled();
  });

  it("falls back to single quotes when spawnSync throws", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("no bash");
    });
    expect(quoteShellEnvValue("a'b")).toBe(`'a'\\''b'`);
  });

  it("falls back when bash returns non-zero", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    expect(quoteShellEnvValue("x")).toBe(`'x'`);
  });
});
