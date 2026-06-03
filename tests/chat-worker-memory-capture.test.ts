import { describe, it, expect, vi } from "vitest";
import {
  OWNER_MEMORY_SYSTEM_PROMPT,
  MEMORY_EXTRACTION_FORMAT,
  extractLatestOwnerMessage,
  normalizeBullets,
  parseMemoryExtraction,
  buildExtractionRequestBody,
  formatSavedConfirmation,
  extractOwnerRule
} from "../vps/chat-worker/memory-capture.mjs";

describe("extractLatestOwnerMessage", () => {
  it("returns the last user message, stripped of the [Dashboard] marker", () => {
    const msgs = [
      { role: "system", content: "preamble" },
      { role: "user", content: "[Dashboard] never discuss budget" }
    ];
    expect(extractLatestOwnerMessage(msgs)).toBe("never discuss budget");
  });

  it("strips [SMS] and [Call] markers too", () => {
    expect(extractLatestOwnerMessage([{ role: "user", content: "[SMS] hi" }])).toBe("hi");
    expect(extractLatestOwnerMessage([{ role: "user", content: "[Call] yo" }])).toBe("yo");
  });

  it("picks the LAST user message when several are present", () => {
    const msgs = [
      { role: "user", content: "[Dashboard] first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "[Dashboard] second" }
    ];
    expect(extractLatestOwnerMessage(msgs)).toBe("second");
  });

  it("returns '' when there is no user message", () => {
    expect(extractLatestOwnerMessage([{ role: "system", content: "x" }])).toBe("");
  });

  it("ignores user entries whose content is not a string", () => {
    expect(extractLatestOwnerMessage([{ role: "user", content: { nested: true } }])).toBe("");
  });

  it("returns '' for non-array / nullish input", () => {
    expect(extractLatestOwnerMessage(null)).toBe("");
    expect(extractLatestOwnerMessage(undefined)).toBe("");
    expect(extractLatestOwnerMessage("nope" as unknown as never)).toBe("");
  });
});

describe("normalizeBullets", () => {
  it("strips leading list punctuation and collapses whitespace", () => {
    expect(normalizeBullets(["- never   discuss  budget"])).toEqual(["never discuss budget"]);
    expect(normalizeBullets(["• always offer estimates"])).toEqual(["always offer estimates"]);
    expect(normalizeBullets(["* be brief"])).toEqual(["be brief"]);
  });

  it("dedupes case-insensitively and drops empties / non-strings", () => {
    expect(
      normalizeBullets(["Never discuss budget", "never discuss budget", "", "   ", 42, null])
    ).toEqual(["Never discuss budget"]);
  });

  it("caps the number of bullets at 10", () => {
    const many = Array.from({ length: 25 }, (_, i) => `rule ${i}`);
    expect(normalizeBullets(many)).toHaveLength(10);
  });

  it("caps each bullet length at 280 chars", () => {
    const long = "x".repeat(500);
    expect(normalizeBullets([long])[0]).toHaveLength(280);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeBullets("nope")).toEqual([]);
    expect(normalizeBullets(null)).toEqual([]);
  });
});

describe("parseMemoryExtraction", () => {
  it("parses a JSON string with save=true and bullets", () => {
    const raw = JSON.stringify({ save: true, bullets: ["never discuss budget"] });
    expect(parseMemoryExtraction(raw)).toEqual({ save: true, bullets: ["never discuss budget"] });
  });

  it("accepts an already-parsed object", () => {
    expect(parseMemoryExtraction({ save: true, bullets: ["be brief"] })).toEqual({
      save: true,
      bullets: ["be brief"]
    });
  });

  it("treats save:true with no usable bullets as a no-op", () => {
    expect(parseMemoryExtraction({ save: true, bullets: [] })).toEqual({ save: false, bullets: [] });
    expect(parseMemoryExtraction({ save: true, bullets: ["   "] })).toEqual({
      save: false,
      bullets: []
    });
  });

  it("returns bullets:[] when save is false", () => {
    expect(parseMemoryExtraction({ save: false, bullets: ["ignored"] })).toEqual({
      save: false,
      bullets: []
    });
  });

  it("degrades to a safe no-op on malformed JSON", () => {
    expect(parseMemoryExtraction("{not json")).toEqual({ save: false, bullets: [] });
  });

  it("degrades to a safe no-op on null / non-object", () => {
    expect(parseMemoryExtraction(null)).toEqual({ save: false, bullets: [] });
    expect(parseMemoryExtraction(7 as unknown as never)).toEqual({ save: false, bullets: [] });
  });

  it("degrades to a safe no-op when bullets is not an array", () => {
    expect(parseMemoryExtraction({ save: true, bullets: "oops" })).toEqual({
      save: false,
      bullets: []
    });
  });
});

describe("buildExtractionRequestBody", () => {
  it("produces a deterministic, structured-output Ollama request", () => {
    const body = buildExtractionRequestBody("qwen3:4b-instruct", "never discuss budget");
    expect(body).toMatchObject({
      model: "qwen3:4b-instruct",
      stream: false,
      format: MEMORY_EXTRACTION_FORMAT,
      options: { temperature: 0 }
    });
    expect(body.messages[0]).toEqual({ role: "system", content: OWNER_MEMORY_SYSTEM_PROMPT });
    expect(body.messages[1]).toEqual({ role: "user", content: "never discuss budget" });
  });
});

describe("formatSavedConfirmation", () => {
  it("renders an honest confirmation block with bullet markers", () => {
    const out = formatSavedConfirmation(["never discuss budget", "offer free estimates"]);
    expect(out).toContain("Saved to your business memory");
    expect(out).toContain("• never discuss budget");
    expect(out).toContain("• offer free estimates");
  });
});

describe("extractOwnerRule", () => {
  const base = "http://host.docker.internal:11434";

  it("returns a no-op without calling fetch when the message is empty", async () => {
    const fetchImpl = vi.fn();
    const res = await extractOwnerRule({
      ownerMessage: "   ",
      model: "m",
      ollamaBaseUrl: base,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(res).toEqual({ save: false, bullets: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a no-op without calling fetch when the base URL is empty", async () => {
    const fetchImpl = vi.fn();
    const res = await extractOwnerRule({
      ownerMessage: "never discuss budget",
      model: "m",
      ollamaBaseUrl: "",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(res).toEqual({ save: false, bullets: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs to /api/chat and returns the parsed extraction on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ save: true, bullets: ["never discuss budget"] }) }
      })
    });
    const res = await extractOwnerRule({
      ownerMessage: "from now on never discuss budget",
      model: "qwen3:4b-instruct",
      ollamaBaseUrl: `${base}/`,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(res).toEqual({ save: true, bullets: ["never discuss budget"] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${base}/api/chat`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).messages[1].content).toBe("from now on never discuss budget");
    expect(init.signal).toBeDefined();
  });

  it("returns a no-op and logs on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const logger = vi.fn();
    const res = await extractOwnerRule({
      ownerMessage: "never discuss budget",
      model: "m",
      ollamaBaseUrl: base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger
    });
    expect(res).toEqual({ save: false, bullets: [] });
    expect(logger).toHaveBeenCalledWith("warn", "memory_extract_http_error", { status: 500 });
  });

  it("returns a no-op and logs when fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const logger = vi.fn();
    const res = await extractOwnerRule({
      ownerMessage: "never discuss budget",
      model: "m",
      ollamaBaseUrl: base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger
    });
    expect(res).toEqual({ save: false, bullets: [] });
    expect(logger).toHaveBeenCalledWith(
      "warn",
      "memory_extract_failed",
      expect.objectContaining({ error: "boom" })
    );
  });
});
