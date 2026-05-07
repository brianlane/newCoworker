import { describe, it, expect } from "vitest";

import { quoteShellEnvValue } from "@/lib/provisioning/orchestrate";

/**
 * `quoteShellEnvValue` produces the canonical bash single-quoted form so the
 * orchestrator's deploy command can carry arbitrary env values over SSH
 * without injection risk. We previously delegated to `bash printf %q` with a
 * pure-JS fallback; the spawn was retired (it cost ~2.5 s per orchestrator
 * test on macOS due to per-process xprotect/dyld overhead) in favour of the
 * JS path as the only implementation. These tests pin the exact quoting
 * contract — same values, same output — so a future regression won't ship a
 * subtly-different deploy command.
 */
describe("quoteShellEnvValue", () => {
  it("wraps simple values in single quotes", () => {
    expect(quoteShellEnvValue("hello")).toBe("'hello'");
  });

  it("wraps the empty string as ''", () => {
    expect(quoteShellEnvValue("")).toBe("''");
  });

  it("escapes embedded single quotes with the '\\'' sequence", () => {
    expect(quoteShellEnvValue("a'b")).toBe("'a'\\''b'");
  });

  it("does not escape shell metacharacters inside single quotes", () => {
    // $, `, *, & etc. are literal inside single quotes — round-tripping
    // through bash yields the original string unchanged.
    expect(quoteShellEnvValue("with$shell`stuff")).toBe("'with$shell`stuff'");
  });

  it("preserves whitespace and unicode literally", () => {
    expect(quoteShellEnvValue("value with spaces")).toBe("'value with spaces'");
    expect(quoteShellEnvValue("unicode★")).toBe("'unicode★'");
  });
});
