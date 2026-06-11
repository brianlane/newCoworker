import { describe, expect, it } from "vitest";
// @ts-expect-error — sidecar is plain JS without types; importing the pure
// helper module avoids booting the HTTP server that index.js binds at load.
import {
  pickUpstream,
  filterUpstreamHeaders,
  mergeSystemMessages,
  addToolCallIndices,
  createSseToolCallIndexNormalizer
} from "../vps/llm-router/src/routing.js";

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

describe("llm-router mergeSystemMessages", () => {
  it("collapses two system messages into one, instructions first (the Gemini last-system-wins fix)", () => {
    const body = {
      model: "gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: "AGENT INSTRUCTIONS with the roster" },
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Who is on the team?" }
      ]
    };
    const out = mergeSystemMessages(body);
    expect(out).not.toBe(body);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toEqual({
      role: "system",
      content: "AGENT INSTRUCTIONS with the roster\n\nYou are a helpful assistant."
    });
    expect(out.messages[1]).toEqual({ role: "user", content: "Who is on the team?" });
    // Original body untouched (callers may reuse it).
    expect(body.messages).toHaveLength(3);
  });

  it("keeps the merged system message at the first system's position and preserves other message order", () => {
    const body = {
      messages: [
        { role: "user", content: "u1" },
        { role: "system", content: "s1" },
        { role: "assistant", content: "a1" },
        { role: "system", content: "s2" },
        { role: "user", content: "u2" }
      ]
    };
    const out = mergeSystemMessages(body);
    expect(out.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
      "user"
    ]);
    expect(out.messages[1].content).toBe("s1\n\ns2");
  });

  it("skips blank system contents when joining", () => {
    const body = {
      messages: [
        { role: "system", content: "real instructions" },
        { role: "system", content: "   " },
        { role: "user", content: "hi" }
      ]
    };
    const out = mergeSystemMessages(body);
    expect(out.messages[0].content).toBe("real instructions");
  });

  it("is a no-op (same reference) for zero or one system message", () => {
    const single = { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] };
    expect(mergeSystemMessages(single)).toBe(single);
    const none = { messages: [{ role: "user", content: "u" }] };
    expect(mergeSystemMessages(none)).toBe(none);
  });

  it("is a no-op for non-string system content (OpenAI content-parts arrays pass through)", () => {
    const body = {
      messages: [
        { role: "system", content: [{ type: "text", text: "part" }] },
        { role: "system", content: "plain" },
        { role: "user", content: "u" }
      ]
    };
    expect(mergeSystemMessages(body)).toBe(body);
  });

  it("is a no-op for bodies without a messages array", () => {
    expect(mergeSystemMessages(null)).toBe(null);
    const noMessages = { model: "gemini-3.1-flash" };
    expect(mergeSystemMessages(noMessages)).toBe(noMessages);
  });
});

describe("llm-router addToolCallIndices", () => {
  // Real shape from Gemini's OpenAI-compat streaming: tool_calls delta with
  // NO index field, which the OpenAI spec requires and the AI SDK enforces.
  function geminiToolCallChunk() {
    return {
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: '{"toE164":"+15551234567"}', name: "send_sms" },
                id: "function-call-123",
                type: "function"
              }
            ]
          },
          finish_reason: "tool_calls",
          index: 0
        }
      ],
      model: "gemini-2.5-flash-lite",
      object: "chat.completion.chunk"
    };
  }

  it("injects array-position index into tool_calls deltas missing it", () => {
    const chunk = geminiToolCallChunk();
    chunk.choices[0].delta.tool_calls.push({
      function: { arguments: "{}", name: "second_tool" },
      id: "function-call-456",
      type: "function"
    } as never);
    expect(addToolCallIndices(chunk)).toBe(true);
    expect(chunk.choices[0].delta.tool_calls.map((t: { index?: number }) => t.index)).toEqual([
      0, 1
    ]);
  });

  it("leaves existing indices alone and reports no change", () => {
    const chunk = geminiToolCallChunk();
    (chunk.choices[0].delta.tool_calls[0] as { index?: number }).index = 0;
    expect(addToolCallIndices(chunk)).toBe(false);
  });

  it("is a no-op for text deltas and malformed payloads", () => {
    expect(addToolCallIndices({ choices: [{ delta: { content: "hi" } }] })).toBe(false);
    expect(addToolCallIndices({ choices: [{}] })).toBe(false);
    expect(addToolCallIndices({})).toBe(false);
    expect(addToolCallIndices(null)).toBe(false);
  });
});

describe("llm-router createSseToolCallIndexNormalizer", () => {
  const toolCallEvent =
    'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"function":{"arguments":"{}","name":"send_sms"},"id":"fc-1","type":"function"}]},"finish_reason":"tool_calls","index":0}],"object":"chat.completion.chunk"}';

  it("rewrites tool-call events to include index", () => {
    const n = createSseToolCallIndexNormalizer();
    const out = n.transform(toolCallEvent + "\n\n") + n.flush();
    const data = JSON.parse(out.split("\n")[0].slice(6));
    expect(data.choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it("passes text deltas, [DONE], comments and blank lines through verbatim", () => {
    const n = createSseToolCallIndexNormalizer();
    const input =
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n: keep-alive\n\ndata: [DONE]\n\n';
    expect(n.transform(input) + n.flush()).toBe(input);
  });

  it("handles events split across network chunks", () => {
    const n = createSseToolCallIndexNormalizer();
    const mid = Math.floor(toolCallEvent.length / 2);
    let out = n.transform(toolCallEvent.slice(0, mid));
    out += n.transform(toolCallEvent.slice(mid) + "\n\n");
    out += n.flush();
    const data = JSON.parse(out.split("\n")[0].slice(6));
    expect(data.choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it("flushes a trailing unterminated event at end-of-stream", () => {
    const n = createSseToolCallIndexNormalizer();
    expect(n.transform(toolCallEvent)).toBe("");
    const out = n.flush();
    const data = JSON.parse(out.slice(6));
    expect(data.choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it("preserves CRLF line endings", () => {
    const n = createSseToolCallIndexNormalizer();
    const out = n.transform(toolCallEvent + "\r\n\r\n") + n.flush();
    expect(out.split("\r\n")[0].endsWith("\r")).toBe(false); // content before \r\n
    const data = JSON.parse(out.split("\r\n")[0].slice(6));
    expect(data.choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it("passes malformed JSON data lines through untouched", () => {
    const n = createSseToolCallIndexNormalizer();
    const input = "data: {not json}\n";
    expect(n.transform(input)).toBe(input);
  });
});
