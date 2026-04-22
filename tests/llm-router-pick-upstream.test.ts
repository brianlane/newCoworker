import { describe, expect, it } from "vitest";
// @ts-expect-error — sidecar is plain JS without types; importing the pure
// helper module avoids booting the HTTP server that index.js binds at load.
import { pickUpstream } from "../vps/llm-router/src/routing.js";

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
