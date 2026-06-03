import { beforeEach, describe, expect, it, vi } from "vitest";

const afterMock = vi.fn();
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => afterMock(cb)
}));
vi.mock("@/lib/vps/sync-vault", () => ({
  syncVaultToVpsAndLog: vi.fn(async () => undefined)
}));

import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleVaultSync", () => {
  it("defers the sync via after() and does not run it synchronously", () => {
    scheduleVaultSync("biz-1");
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(syncVaultToVpsAndLog).not.toHaveBeenCalled();
  });

  it("runs syncVaultToVpsAndLog with the businessId when the deferred callback fires", async () => {
    scheduleVaultSync("biz-1");
    const cb = afterMock.mock.calls[0][0] as () => unknown;
    await cb();
    expect(syncVaultToVpsAndLog).toHaveBeenCalledWith("biz-1");
  });
});
