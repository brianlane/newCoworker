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
});
