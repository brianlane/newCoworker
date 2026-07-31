import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "@/lib/logger";

describe("logger", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("logger.info calls console.log with JSON", () => {
    logger.info("test message", { key: "val" });
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const call = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(call);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("test message");
    expect(parsed.key).toBe("val");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("logger.debug calls console.log", () => {
    logger.debug("debug msg");
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("debug");
  });

  it("logger.warn calls console.error", () => {
    logger.warn("warn msg");
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("warn");
  });

  it("logger.error calls console.error", () => {
    logger.error("error msg", { err: "boom" });
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("error");
    expect(parsed.err).toBe("boom");
  });

  it("logger methods work without context", () => {
    logger.info("no context");
    expect(consoleLogSpy).toHaveBeenCalledOnce();
  });

  // CASA 6.5.1
  it("redacts secrets out of the context before writing the line", () => {
    logger.info("sign-in", { email: "a@b.com", password: "hunter2" });
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    expect(raw).not.toContain("hunter2");
    const parsed = JSON.parse(raw);
    expect(parsed.password).toBe("[redacted]");
    expect(parsed.email).toBe("a@b.com");
  });

  it("redacts nested secrets too", () => {
    logger.error("stripe webhook", { event: { id: "evt_1", apiKey: "sk_live_x" } });
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    expect(raw).not.toContain("sk_live_x");
    expect(JSON.parse(raw).event).toEqual({ id: "evt_1", apiKey: "[redacted]" });
  });

  // Call sites such as the admin costs/gemini/usage pages and
  // platform-cost-sync pass `message: err.message` alongside a static log
  // string. Redaction must not change which one survives, or the exception
  // text disappears from the log line.
  it("keeps a context message overriding the static log string, as before", () => {
    logger.error("admin/costs: refresh failed", { message: "connection reset" });
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(parsed.message).toBe("connection reset");
  });
});
