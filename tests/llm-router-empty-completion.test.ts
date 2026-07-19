import { describe, expect, it } from "vitest";
// @ts-expect-error — sidecar is plain JS without types; importing the pure
// helper module avoids booting the HTTP server that index.js binds at load.
// prettier-ignore — single line so the ts-expect-error covers the untyped import
import { chatCompletionHasOutput, createSseEmptyCompletionProbe } from "../vps/llm-router/src/routing.js";

// Real shape captured live 2026-07-19 (HQ tenant, gemini-2.5-flash via the
// OpenAI-compat endpoint): a "completion" with finish_reason stop, a role-only
// delta, and zero completion tokens. Rowboat's agent loop burned one SDK turn
// per such chunk until "Max turns (25) exceeded".
const EMPTY_STREAM_CHUNK =
  'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":"stop","index":0}],"created":1784482218,"id":"qg","model":"gemini-2.5-flash","object":"chat.completion.chunk","usage":{"completion_tokens":0,"prompt_tokens":5051,"total_tokens":5051}}';

describe("llm-router chatCompletionHasOutput", () => {
  it("treats a role-only delta with finish_reason stop as NO output (the stuck-Gemini shape)", () => {
    const parsed = JSON.parse(EMPTY_STREAM_CHUNK.slice(6));
    expect(chatCompletionHasOutput(parsed)).toBe(false);
  });

  it("counts streamed text content as output", () => {
    expect(
      chatCompletionHasOutput({ choices: [{ delta: { content: "Hi" }, index: 0 }] })
    ).toBe(true);
  });

  it("counts streamed tool calls as output", () => {
    expect(
      chatCompletionHasOutput({
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [{ id: "fc-1", type: "function", function: { name: "send_sms", arguments: "{}" } }]
            }
          }
        ]
      })
    ).toBe(true);
  });

  it("counts non-streamed message content and tool calls as output", () => {
    expect(
      chatCompletionHasOutput({ choices: [{ message: { role: "assistant", content: "hello" } }] })
    ).toBe(true);
    expect(
      chatCompletionHasOutput({
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x" }] } }]
      })
    ).toBe(true);
  });

  it("counts a refusal as output (it is a deliberate model response, not a stuck one)", () => {
    expect(
      chatCompletionHasOutput({ choices: [{ message: { role: "assistant", refusal: "no" } }] })
    ).toBe(true);
  });

  it("treats empty content / empty tool_calls / usage-only chunks as NO output", () => {
    expect(chatCompletionHasOutput({ choices: [{ delta: { content: "" } }] })).toBe(false);
    expect(chatCompletionHasOutput({ choices: [{ delta: { tool_calls: [] } }] })).toBe(false);
    expect(chatCompletionHasOutput({ choices: [], usage: { prompt_tokens: 9 } })).toBe(false);
  });

  it("is false for malformed payloads", () => {
    expect(chatCompletionHasOutput(null)).toBe(false);
    expect(chatCompletionHasOutput({})).toBe(false);
    expect(chatCompletionHasOutput({ choices: [null] })).toBe(false);
  });
});

describe("llm-router createSseEmptyCompletionProbe", () => {
  it("reports no output, the finish reason, and the billed usage for an all-empty stream", () => {
    const p = createSseEmptyCompletionProbe();
    p.collect(EMPTY_STREAM_CHUNK + "\n\n");
    p.collect("data: [DONE]\n\n");
    p.flush();
    expect(p.sawOutput()).toBe(false);
    expect(p.finishReason()).toBe("stop");
    // The dropped attempt's prompt tokens were still billed by Google.
    expect(p.usage()).toEqual({ promptTokens: 5051, outputTokens: 0 });
  });

  it("flips sawOutput as soon as a content chunk arrives", () => {
    const p = createSseEmptyCompletionProbe();
    p.collect('data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n');
    expect(p.sawOutput()).toBe(false);
    p.collect('data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n');
    expect(p.sawOutput()).toBe(true);
  });

  it("flips sawOutput for a tool-call chunk (a tool call is real output)", () => {
    const p = createSseEmptyCompletionProbe();
    p.collect(
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"id":"fc-1","type":"function","function":{"name":"send_sms","arguments":"{}"}}]},"finish_reason":"tool_calls","index":0}]}\n\n'
    );
    expect(p.sawOutput()).toBe(true);
    expect(p.finishReason()).toBe("tool_calls");
  });

  it("reassembles events split across network chunks", () => {
    const p = createSseEmptyCompletionProbe();
    const event = 'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}';
    const mid = Math.floor(event.length / 2);
    p.collect(event.slice(0, mid));
    expect(p.sawOutput()).toBe(false);
    p.collect(event.slice(mid) + "\n\n");
    expect(p.sawOutput()).toBe(true);
  });

  it("drains a trailing unterminated line via flush()", () => {
    const p = createSseEmptyCompletionProbe();
    p.collect('data: {"choices":[{"delta":{"content":"tail"},"index":0}]}'); // no newline
    expect(p.sawOutput()).toBe(false);
    p.flush();
    expect(p.sawOutput()).toBe(true);
  });

  it("tolerates CRLF endings, comments, malformed data lines, and [DONE]", () => {
    const p = createSseEmptyCompletionProbe();
    p.collect(": keep-alive\r\n");
    p.collect("data: {not json}\r\n");
    p.collect("data: [DONE]\r\n");
    p.flush();
    expect(p.sawOutput()).toBe(false);
    expect(p.finishReason()).toBeNull();
    expect(p.usage()).toBeNull();
  });

  it("keeps the LAST finish reason and usage seen", () => {
    const p = createSseEmptyCompletionProbe();
    p.collect(EMPTY_STREAM_CHUNK + "\n");
    p.collect(
      'data: {"choices":[{"delta":{},"finish_reason":"length","index":0}],"usage":{"prompt_tokens":7,"completion_tokens":0}}\n'
    );
    p.flush();
    expect(p.finishReason()).toBe("length");
    expect(p.usage()).toEqual({ promptTokens: 7, outputTokens: 0 });
  });
});
