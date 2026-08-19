import { describe, expect, it } from "vitest";
import {
  HIPAA_IDLE_TIMEOUT_MS,
  HIPAA_IDLE_WARNING_MS,
  SESSION_TIMEOUT_ERROR,
  idleMsSince,
  idleState,
  secondsUntilLogout
} from "@/lib/hipaa/session-timeout";

const T0 = 1_700_000_000_000;

describe("hipaa/session-timeout", () => {
  it("pins the policy numbers so a change is a deliberate edit", () => {
    expect(HIPAA_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(HIPAA_IDLE_WARNING_MS).toBe(2 * 60 * 1000);
    expect(SESSION_TIMEOUT_ERROR).toBe("session_timeout");
  });

  describe("idleMsSince", () => {
    it("measures elapsed idle time", () => {
      expect(idleMsSince(T0, T0 + 5000)).toBe(5000);
    });

    it("floors a future lastActivity at zero rather than going negative", () => {
      // A clock adjustment or a restored tab must read as "just active", not
      // as a negative age that could never reach the timeout.
      expect(idleMsSince(T0 + 10_000, T0)).toBe(0);
    });
  });

  describe("idleState", () => {
    it("is active well inside the window", () => {
      expect(idleState(T0, T0)).toBe("active");
      expect(idleState(T0, T0 + 60_000)).toBe("active");
    });

    it("is active right up to the warning boundary", () => {
      const justBefore = T0 + HIPAA_IDLE_TIMEOUT_MS - HIPAA_IDLE_WARNING_MS - 1;
      expect(idleState(T0, justBefore)).toBe("active");
    });

    it("warns exactly at the warning boundary", () => {
      const atBoundary = T0 + HIPAA_IDLE_TIMEOUT_MS - HIPAA_IDLE_WARNING_MS;
      expect(idleState(T0, atBoundary)).toBe("warning");
    });

    it("expires exactly at the timeout, not a tick later", () => {
      expect(idleState(T0, T0 + HIPAA_IDLE_TIMEOUT_MS - 1)).toBe("warning");
      expect(idleState(T0, T0 + HIPAA_IDLE_TIMEOUT_MS)).toBe("expired");
      expect(idleState(T0, T0 + HIPAA_IDLE_TIMEOUT_MS + 60_000)).toBe("expired");
    });

    it("honors a custom window and warning lead", () => {
      expect(idleState(T0, T0 + 4000, 10_000, 5000)).toBe("active");
      expect(idleState(T0, T0 + 5000, 10_000, 5000)).toBe("warning");
      expect(idleState(T0, T0 + 10_000, 10_000, 5000)).toBe("expired");
    });
  });

  describe("secondsUntilLogout", () => {
    it("counts down in whole seconds", () => {
      expect(secondsUntilLogout(T0, T0)).toBe(HIPAA_IDLE_TIMEOUT_MS / 1000);
      expect(secondsUntilLogout(T0, T0 + 60_000)).toBe(HIPAA_IDLE_TIMEOUT_MS / 1000 - 60);
    });

    it("rounds a partial second UP, so the countdown never shows 0 while alive", () => {
      expect(secondsUntilLogout(T0, T0 + HIPAA_IDLE_TIMEOUT_MS - 1500)).toBe(2);
      expect(secondsUntilLogout(T0, T0 + HIPAA_IDLE_TIMEOUT_MS - 1)).toBe(1);
    });

    it("floors at zero once expired", () => {
      expect(secondsUntilLogout(T0, T0 + HIPAA_IDLE_TIMEOUT_MS)).toBe(0);
      expect(secondsUntilLogout(T0, T0 + HIPAA_IDLE_TIMEOUT_MS + 999_999)).toBe(0);
    });

    it("honors a custom window", () => {
      expect(secondsUntilLogout(T0, T0, 10_000)).toBe(10);
    });
  });
});
