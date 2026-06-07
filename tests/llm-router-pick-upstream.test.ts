import { describe, expect, it } from "vitest";
// @ts-expect-error — sidecar is plain JS without types; importing the pure
// helper module avoids booting the HTTP server that index.js binds at load.
import { pickUpstream, filterUpstreamHeaders } from "../vps/llm-router/src/routing.js";

describe("llm-router pickUpstream", () => {
  it("routes gemini-* models to Gemini", () => {
    expect(pickUpstream("gemini-3.1-flash")).toBe("gemini");
    expect(pickUpstream("gemini-3.1-pro")).toBe("gemini");
    expect(pickUpstream("Gemini-1.5-flash")).toBe("gemini"); // case-insensitive
    expect(pickUpstream("gemini_2.5_flash")).toBe("gemini");
  });

  it("routes Ollama-native tags (llama*, qwen*, plain strings) to Ollama", () => {
    expect(pickUpstream("llama3.2:3b")).toBe("ollama");
    expect(pickUpstream("qwen3:4b-instruct")).toBe("ollama");
    expect(pickUpstream("phi3:mini")).toBe("ollama");
  });

  it("falls back to Ollama for missing / non-string model fields", () => {
    expect(pickUpstream(undefined)).toBe("ollama");
    expect(pickUpstream(null)).toBe("ollama");
    expect(pickUpstream(42)).toBe("ollama");
    expect(pickUpstream("")).toBe("ollama");
  });

  it("does NOT match models whose name only CONTAINS 'gemini' elsewhere (avoid false positives)", () => {
    // `my-gemini-custom` should stay on Ollama — the router is deliberately
    // anchored at the start of the name so mis-tagged models don't jump
    // providers.
    expect(pickUpstream("my-gemini-custom")).toBe("ollama");
  });
});

describe("llm-router filterUpstreamHeaders", () => {
  // Mimic a WHATWG Headers object (what undici's fetch Response exposes):
  // forEach yields (value, key) and keys are already lowercased.
  function fakeHeaders(entries: Record<string, string>) {
    return {
      forEach(cb: (value: string, key: string) => void) {
        for (const [k, v] of Object.entries(entries)) cb(v, k.toLowerCase());
      }
    };
  }

  it("drops content-encoding/content-length so a decoded body isn't re-gunzipped (the Z_DATA_ERROR fix)", () => {
    const out = filterUpstreamHeaders(
      fakeHeaders({
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "303",
        "cache-control": "private"
      })
    );
    expect(out["content-encoding"]).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
    expect(out["content-type"]).toBe("application/json");
    expect(out["cache-control"]).toBe("private");
  });

  it("drops hop-by-hop framing headers Node manages itself", () => {
    const out = filterUpstreamHeaders(
      fakeHeaders({
        "transfer-encoding": "chunked",
        connection: "close",
        "keep-alive": "timeout=5",
        "x-keep": "1"
      })
    );
    expect(out["transfer-encoding"]).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out["keep-alive"]).toBeUndefined();
    expect(out["x-keep"]).toBe("1");
  });

  it("lowercases keys and preserves passthrough headers (SSE stays intact)", () => {
    const out = filterUpstreamHeaders(fakeHeaders({ "Content-Type": "text/event-stream" }));
    expect(out["content-type"]).toBe("text/event-stream");
  });

  it("accepts a plain object of headers, not just a Headers instance", () => {
    const out = filterUpstreamHeaders({ "Content-Encoding": "br", "X-Trace": "abc" });
    expect(out["content-encoding"]).toBeUndefined();
    expect(out["x-trace"]).toBe("abc");
  });

  it("returns an empty object for null/undefined/non-iterable input", () => {
    expect(filterUpstreamHeaders(null)).toEqual({});
    expect(filterUpstreamHeaders(undefined)).toEqual({});
    expect(filterUpstreamHeaders(42)).toEqual({});
  });
});
