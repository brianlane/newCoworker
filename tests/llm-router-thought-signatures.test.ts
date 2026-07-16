/**
 * llm-router Gemini 3.x thought-signature shim (vps/llm-router/src/routing.js):
 * model gating, LRU cache semantics, response harvesting (JSON + SSE deltas),
 * and request injection (cached signature, placeholder fallback, never
 * overwrite). Context: Gemini 3.x 400s ("Function call is missing a
 * thought_signature") when a replayed assistant tool call lacks
 * `extra_content.google.thought_signature`, and Rowboat's SDK layers drop the
 * field — the router repairs it transparently (verified live 2026-07-16).
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — sidecar is plain JS without types; importing the pure
// helper module avoids booting the HTTP server that index.js binds at load.
// prettier-ignore — single line so the ts-expect-error covers the untyped import
import { needsThoughtSignatures, createSignatureCache, harvestThoughtSignatures, injectThoughtSignatures, createSseSignatureHarvester, THOUGHT_SIGNATURE_PLACEHOLDER } from "../vps/llm-router/src/routing.js";

function toolCall(id: string, signature?: string) {
  return {
    id,
    type: "function",
    function: { name: "get_weather", arguments: '{"city":"Kitchener"}' },
    ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {})
  };
}

describe("needsThoughtSignatures", () => {
  it("matches only the Gemini 3 family", () => {
    expect(needsThoughtSignatures("gemini-3.5-flash")).toBe(true);
    expect(needsThoughtSignatures("gemini-3-flash-preview")).toBe(true);
    expect(needsThoughtSignatures("gemini-3.1-flash-lite")).toBe(true);
    expect(needsThoughtSignatures("Gemini-3.5-Flash")).toBe(true);
    expect(needsThoughtSignatures("  gemini-3.5-flash  ")).toBe(true);
    expect(needsThoughtSignatures("gemini-2.5-flash")).toBe(false);
    expect(needsThoughtSignatures("gemini-2.5-flash-lite")).toBe(false);
    expect(needsThoughtSignatures("qwen3:4b-instruct")).toBe(false);
    expect(needsThoughtSignatures("llama3.2:3b")).toBe(false);
    expect(needsThoughtSignatures(undefined)).toBe(false);
    expect(needsThoughtSignatures(42)).toBe(false);
    expect(needsThoughtSignatures("")).toBe(false);
  });
});

describe("createSignatureCache", () => {
  it("stores, retrieves, and refuses junk keys/values", () => {
    const cache = createSignatureCache();
    cache.set("id-1", "sig-1");
    expect(cache.get("id-1")).toBe("sig-1");
    cache.set("", "sig-x");
    cache.set("id-2", "");
    cache.set(null, "sig-x");
    cache.set("id-3", null);
    expect(cache.size()).toBe(1);
  });

  it("evicts the oldest entry past the cap, and re-setting refreshes recency", () => {
    const cache = createSignatureCache(2);
    cache.set("a", "sa");
    cache.set("b", "sb");
    // Refresh "a" so "b" is now the oldest.
    cache.set("a", "sa2");
    cache.set("c", "sc");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("sa2");
    expect(cache.get("c")).toBe("sc");
    expect(cache.size()).toBe(2);
  });
});

describe("harvestThoughtSignatures", () => {
  it("harvests from non-streamed choices[].message.tool_calls", () => {
    const cache = createSignatureCache();
    const n = harvestThoughtSignatures(
      { choices: [{ message: { role: "assistant", tool_calls: [toolCall("tc-1", "sig-real")] } }] },
      cache
    );
    expect(n).toBe(1);
    expect(cache.get("tc-1")).toBe("sig-real");
  });

  it("harvests from streamed choices[].delta.tool_calls", () => {
    const cache = createSignatureCache();
    const n = harvestThoughtSignatures(
      { choices: [{ delta: { role: "assistant", tool_calls: [toolCall("tc-2", "sig-delta")] } }] },
      cache
    );
    expect(n).toBe(1);
    expect(cache.get("tc-2")).toBe("sig-delta");
  });

  it("ignores calls without ids or signatures, and junk payloads", () => {
    const cache = createSignatureCache();
    expect(
      harvestThoughtSignatures(
        {
          choices: [
            { message: { tool_calls: [toolCall("tc-3"), { function: {} }, null] } },
            { message: { content: "plain text" } },
            {}
          ]
        },
        cache
      )
    ).toBe(0);
    expect(harvestThoughtSignatures(null, cache)).toBe(0);
    expect(harvestThoughtSignatures({ choices: "nope" }, cache)).toBe(0);
    expect(cache.size()).toBe(0);
  });
});

describe("injectThoughtSignatures", () => {
  it("injects the cached signature by tool-call id", () => {
    const cache = createSignatureCache();
    cache.set("tc-1", "sig-real");
    const assistantMsg = { role: "assistant", content: null, tool_calls: [toolCall("tc-1")] };
    const body = {
      model: "gemini-3.5-flash",
      messages: [
        { role: "user", content: "weather?" },
        assistantMsg,
        { role: "tool", tool_call_id: "tc-1", content: "{}" }
      ]
    };
    const result = injectThoughtSignatures(body, cache);
    expect(result.cached).toBe(1);
    expect(result.placeholders).toBe(0);
    expect(result.body.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe(
      "sig-real"
    );
    // Original body untouched (copy-on-write).
    expect(assistantMsg.tool_calls[0]?.extra_content).toBeUndefined();
  });

  it("falls back to the placeholder when the cache has nothing", () => {
    const cache = createSignatureCache();
    const result = injectThoughtSignatures(
      { messages: [{ role: "assistant", tool_calls: [toolCall("unknown-id")] }] },
      cache
    );
    expect(result.cached).toBe(0);
    expect(result.placeholders).toBe(1);
    expect(result.body.messages[0].tool_calls[0].extra_content.google.thought_signature).toBe(
      THOUGHT_SIGNATURE_PLACEHOLDER
    );
  });

  it("never overwrites an existing signature", () => {
    const cache = createSignatureCache();
    cache.set("tc-1", "sig-from-cache");
    const body = {
      messages: [{ role: "assistant", tool_calls: [toolCall("tc-1", "sig-original")] }]
    };
    const result = injectThoughtSignatures(body, cache);
    expect(result.cached).toBe(0);
    expect(result.placeholders).toBe(0);
    // No-op returns the original object so callers can skip re-serializing.
    expect(result.body).toBe(body);
  });

  it("handles several messages/calls, preserving other extra_content and skipping junk", () => {
    const cache = createSignatureCache();
    cache.set("tc-b", "sig-b");
    const body = {
      messages: [
        { role: "assistant", content: "no tools here" },
        {
          role: "assistant",
          tool_calls: [
            { ...toolCall("tc-a"), extra_content: { google: { other: "keep" } } },
            toolCall("tc-b"),
            "junk",
            { type: "function", function: { name: "x" } } // no id
          ]
        },
        { role: "user", content: "hi" }
      ]
    };
    const result = injectThoughtSignatures(body, cache);
    expect(result.cached).toBe(1);
    expect(result.placeholders).toBe(2); // tc-a (unknown) + id-less call
    const calls = result.body.messages[1].tool_calls;
    expect(calls[0].extra_content.google).toEqual({
      other: "keep",
      thought_signature: THOUGHT_SIGNATURE_PLACEHOLDER
    });
    expect(calls[1].extra_content.google.thought_signature).toBe("sig-b");
    expect(calls[2]).toBe("junk");
    expect(calls[3].extra_content.google.thought_signature).toBe(THOUGHT_SIGNATURE_PLACEHOLDER);
    // Untouched messages keep identity.
    expect(result.body.messages[0]).toBe(body.messages[0]);
    expect(result.body.messages[2]).toBe(body.messages[2]);
  });

  it("no-ops on bodies without messages", () => {
    const cache = createSignatureCache();
    const body = { model: "gemini-3.5-flash" };
    expect(injectThoughtSignatures(body, cache).body).toBe(body);
    expect(injectThoughtSignatures(null, cache).body).toBe(null);
  });
});

describe("createSseSignatureHarvester", () => {
  it("harvests signatures from data lines split across chunks, flushing the tail", () => {
    const cache = createSignatureCache();
    const harvester = createSseSignatureHarvester(cache);
    const event = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [toolCall("tc-sse", "sig-sse")] } }]
    })}\n\n`;
    // Split mid-JSON to prove line buffering works.
    harvester.collect(event.slice(0, 25));
    expect(cache.size()).toBe(0);
    harvester.collect(event.slice(25));
    expect(cache.get("tc-sse")).toBe("sig-sse");

    // Unterminated trailing line only lands on flush.
    const tail = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [toolCall("tc-tail", "sig-tail")] } }]
    })}`;
    harvester.collect(tail);
    expect(cache.get("tc-tail")).toBeUndefined();
    harvester.flush();
    expect(cache.get("tc-tail")).toBe("sig-tail");
  });

  it("passes over [DONE], comments, blanks, CRLF lines, and non-JSON without caching", () => {
    const cache = createSignatureCache();
    const harvester = createSseSignatureHarvester(cache);
    harvester.collect("data: [DONE]\n: keep-alive comment\n\ndata: not-json{\r\n");
    harvester.flush();
    expect(cache.size()).toBe(0);
  });
});
