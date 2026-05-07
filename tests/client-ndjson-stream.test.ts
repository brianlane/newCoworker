import { describe, expect, it } from "vitest";
import {
  consumeNdjsonChunk,
  flushNdjsonBuffer,
  type NdjsonBuffer
} from "../src/lib/client/ndjson-stream";

type Ev = { type: string; n?: number; content?: string };

describe("consumeNdjsonChunk", () => {
  it("parses one complete line per chunk", () => {
    const state: NdjsonBuffer = { buffer: "" };
    const r = consumeNdjsonChunk<Ev>(state, '{"type":"meta","n":1}\n');
    expect(r.events).toEqual([{ type: "meta", n: 1 }]);
    expect(r.parseErrorCount).toBe(0);
    expect(state.buffer).toBe("");
  });

  it("parses multiple events in a single chunk", () => {
    const state: NdjsonBuffer = { buffer: "" };
    const chunk =
      '{"type":"meta"}\n{"type":"delta","content":"hi"}\n{"type":"done"}\n';
    const r = consumeNdjsonChunk<Ev>(state, chunk);
    expect(r.events.map((e) => e.type)).toEqual(["meta", "delta", "done"]);
    expect(state.buffer).toBe("");
  });

  it("buffers a partial trailing line across chunks until the newline arrives", () => {
    // Streaming reality: a single TCP frame can split a JSON event in
    // half. The parser MUST keep the partial bytes in `state.buffer`
    // and emit the event on the next chunk that completes the line.
    const state: NdjsonBuffer = { buffer: "" };
    const r1 = consumeNdjsonChunk<Ev>(state, '{"type":"de');
    expect(r1.events).toEqual([]);
    expect(state.buffer).toBe('{"type":"de');
    const r2 = consumeNdjsonChunk<Ev>(state, 'lta","content":"hi"}\n');
    expect(r2.events).toEqual([{ type: "delta", content: "hi" }]);
    expect(state.buffer).toBe("");
  });

  it("ignores blank lines (some intermediaries emit keep-alive newlines)", () => {
    const state: NdjsonBuffer = { buffer: "" };
    const r = consumeNdjsonChunk<Ev>(state, '\n\n{"type":"ping"}\n\n');
    expect(r.events).toEqual([{ type: "ping" }]);
    expect(r.parseErrorCount).toBe(0);
  });

  it("counts parse errors but never throws — losing one garbled event must not kill the stream", () => {
    const state: NdjsonBuffer = { buffer: "" };
    const r = consumeNdjsonChunk<Ev>(state, "not json\n{\"type\":\"ok\"}\n");
    expect(r.events).toEqual([{ type: "ok" }]);
    expect(r.parseErrorCount).toBe(1);
  });

  it("preserves order across multiple chunks", () => {
    const state: NdjsonBuffer = { buffer: "" };
    consumeNdjsonChunk<Ev>(state, '{"type":"a"}\n{"type":"b"}\n');
    const r2 = consumeNdjsonChunk<Ev>(state, '{"type":"c"}\n');
    expect(r2.events.map((e) => e.type)).toEqual(["c"]);
  });
});

describe("flushNdjsonBuffer", () => {
  it("returns nothing when the buffer is empty (well-formed stream end)", () => {
    const state: NdjsonBuffer = { buffer: "" };
    expect(flushNdjsonBuffer<Ev>(state)).toEqual({
      events: [],
      parseErrorCount: 0
    });
  });

  it("parses a trailing partial line that wasn't terminated with a newline (clipped final byte from intermediary)", () => {
    const state: NdjsonBuffer = { buffer: '{"type":"done"}' };
    const r = flushNdjsonBuffer<Ev>(state);
    expect(r.events).toEqual([{ type: "done" }]);
    expect(state.buffer).toBe("");
  });

  it("counts a parse error for a malformed trailing fragment without throwing", () => {
    const state: NdjsonBuffer = { buffer: "{half-event" };
    const r = flushNdjsonBuffer<Ev>(state);
    expect(r.events).toEqual([]);
    expect(r.parseErrorCount).toBe(1);
    expect(state.buffer).toBe("");
  });
});
