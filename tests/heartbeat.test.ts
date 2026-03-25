import { describe, expect, it } from "vitest";
import { nextHeartbeatState } from "@/lib/monitoring/heartbeat";

describe("heartbeat state machine", () => {
  it("resets failures when healthy", () => {
    expect(nextHeartbeatState(2, true)).toEqual({
      failures: 0,
      restarted: false,
      escalate: false
    });
  });

  it("triggers restart on third failure", () => {
    expect(nextHeartbeatState(2, false)).toEqual({
      failures: 3,
      restarted: true,
      escalate: false
    });
  });

  it("escalates after third failure", () => {
    expect(nextHeartbeatState(3, false)).toEqual({
      failures: 4,
      restarted: false,
      escalate: true
    });
  });
});
