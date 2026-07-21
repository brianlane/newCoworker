import { describe, it, expect, vi } from "vitest";
import {
  OWNER_MEMORY_SYSTEM_PROMPT,
  MEMORY_EXTRACTION_FORMAT,
  ADAPTER_BULLETS_MAX_CHARS,
  extractLatestOwnerMessage,
  extractExistingBullets,
  composeExtractionInput,
  normalizeBullets,
  parseMemoryExtraction,
  buildExtractionRequestBody,
  buildExtractionRequestBodyOpenAI,
  MEMORY_EXTRACTION_JSON_SCHEMA,
  fitBulletsToPayload,
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

describe("extractExistingBullets", () => {
  it("pulls markdown list lines and strips the marker", () => {
    const md = [
      "## Owner Rules",
      "- Never discuss budget.",
      "* Offer free estimates",
      "  • Closed Sundays",
      "",
      "Some prose that is not a bullet."
    ].join("\n");
    expect(extractExistingBullets(md)).toEqual([
      "Never discuss budget.",
      "Offer free estimates",
      "Closed Sundays"
    ]);
  });

  it("returns [] for empty / non-string input", () => {
    expect(extractExistingBullets("")).toEqual([]);
    expect(extractExistingBullets(null as unknown as string)).toEqual([]);
  });
});

describe("composeExtractionInput", () => {
  it("includes only the owner message when no extras are given", () => {
    expect(composeExtractionInput("never discuss budget")).toBe(
      "OWNER MESSAGE:\nnever discuss budget"
    );
  });

  it("appends the assistant reply and already-saved bullets when provided", () => {
    const out = composeExtractionInput("add Dave 602-524-5719 for memory", {
      assistantReply: "Dave: 602-524-5719. All changes applied to your memory.",
      existingBullets: ["Never discuss budget", "  ", 5 as unknown as string]
    });
    expect(out).toContain("OWNER MESSAGE:\nadd Dave 602-524-5719 for memory");
    expect(out).toContain("ASSISTANT REPLY");
    expect(out).toContain("Dave: 602-524-5719");
    expect(out).toContain("ALREADY SAVED IN MEMORY");
    expect(out).toContain("- Never discuss budget");
  });

  it("omits empty assistant reply and empty existing-bullets sections", () => {
    const out = composeExtractionInput("hello", { assistantReply: "   ", existingBullets: [] });
    expect(out).toBe("OWNER MESSAGE:\nhello");
  });

  it("frames the assistant reply as reference-resolution context, never a value source", () => {
    // Regression pin (KYP Ads, Jul 2026): the old "STRONG signal to save"
    // framing persisted assistant-invented policy as durable business fact.
    const out = composeExtractionInput("msg", { assistantReply: "reply" });
    expect(out).toContain("reference-resolution context ONLY");
    expect(out).toContain("IGNORE any claim");
    expect(out).not.toMatch(/STRONG signal/i);
  });
});

describe("OWNER_MEMORY_SYSTEM_PROMPT contract", () => {
  it("pins the owner-only source rule and the KYP anti-patterns", () => {
    expect(OWNER_MEMORY_SYSTEM_PROMPT).toContain("ONLY SOURCE OF SAVED FACTS");
    expect(OWNER_MEMORY_SYSTEM_PROMPT).toContain("suggestions, proposals, drafts, plans");
    expect(OWNER_MEMORY_SYSTEM_PROMPT).toContain("open or undecided items");
    expect(OWNER_MEMORY_SYSTEM_PROMPT).toContain("wrong, changing, or going away");
    expect(OWNER_MEMORY_SYSTEM_PROMPT).not.toMatch(/strong save\s*signal/i);
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
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("never discuss budget");
  });

  it("threads assistant reply + existing bullets into the user turn", () => {
    const body = buildExtractionRequestBody("m", "remember Dave 602-524-5719", {
      assistantReply: "Saved Dave to memory.",
      existingBullets: ["Never discuss budget"]
    });
    expect(body.messages[1].content).toContain("remember Dave 602-524-5719");
    expect(body.messages[1].content).toContain("Saved Dave to memory.");
    expect(body.messages[1].content).toContain("Never discuss budget");
  });
});

describe("buildExtractionRequestBodyOpenAI", () => {
  it("produces a deterministic, json_schema OpenAI request", () => {
    const body = buildExtractionRequestBodyOpenAI("gemini-2.5-flash-lite", "never discuss budget");
    expect(body).toMatchObject({
      model: "gemini-2.5-flash-lite",
      stream: false,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: MEMORY_EXTRACTION_JSON_SCHEMA }
    });
    expect(body.messages[0]).toEqual({ role: "system", content: OWNER_MEMORY_SYSTEM_PROMPT });
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("never discuss budget");
  });

  it("threads assistant reply + existing bullets into the user turn", () => {
    const body = buildExtractionRequestBodyOpenAI("gemini-2.5-flash-lite", "remember Dave", {
      assistantReply: "Saved Dave to memory.",
      existingBullets: ["Never discuss budget"]
    });
    expect(body.messages[1].content).toContain("remember Dave");
    expect(body.messages[1].content).toContain("Saved Dave to memory.");
    expect(body.messages[1].content).toContain("Never discuss budget");
  });

  it("constrains Gemini 3 thinking via reasoning_effort; 2.5/local bodies stay byte-identical", () => {
    const g3 = buildExtractionRequestBodyOpenAI("gemini-3.5-flash-lite", "never discuss budget");
    expect(g3.reasoning_effort).toBe("low");
    const g25 = buildExtractionRequestBodyOpenAI("gemini-2.5-flash-lite", "never discuss budget");
    expect("reasoning_effort" in g25).toBe(false);
  });
});

describe("fitBulletsToPayload", () => {
  it("keeps all bullets when they fit the budget", () => {
    const bullets = ["never discuss budget", "offer free estimates"];
    expect(fitBulletsToPayload(bullets)).toEqual(bullets);
  });

  it("never lets the newline-joined payload exceed the adapter limit", () => {
    const bullets = Array.from({ length: 10 }, () => "x".repeat(280));
    const fitted = fitBulletsToPayload(bullets);
    expect(fitted.join("\n").length).toBeLessThanOrEqual(ADAPTER_BULLETS_MAX_CHARS);
    expect(fitted.length).toBeLessThan(bullets.length);
  });

  it("truncates a single oversized bullet to fit", () => {
    const fitted = fitBulletsToPayload(["y".repeat(5000)], 100);
    expect(fitted).toHaveLength(1);
    expect(fitted[0]).toHaveLength(100);
  });

  it("skips non-string entries and returns [] for non-array input", () => {
    expect(fitBulletsToPayload(["ok", 5 as unknown as string])).toEqual(["ok"]);
    expect(fitBulletsToPayload(null as unknown as string[])).toEqual([]);
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
    expect(JSON.parse(init.body).messages[1].content).toContain("from now on never discuss budget");
    expect(init.signal).toBeDefined();
  });

  it("threads assistantReply + existingBullets through to the request body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: JSON.stringify({ save: true, bullets: ["x"] }) } })
    });
    await extractOwnerRule({
      ownerMessage: "remember Dave 602-524-5719",
      assistantReply: "Saved Dave to your memory.",
      existingBullets: ["Never discuss budget"],
      model: "qwen3:4b-instruct",
      ollamaBaseUrl: base,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const content = JSON.parse(fetchImpl.mock.calls[0][1].body).messages[1].content;
    expect(content).toContain("remember Dave 602-524-5719");
    expect(content).toContain("Saved Dave to your memory.");
    expect(content).toContain("Never discuss budget");
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

  // --- gemini-* models call Google's OpenAI-compat endpoint DIRECTLY ---
  const gemini = "https://generativelanguage.googleapis.com/v1beta/openai";

  it("POSTs gemini-* directly to Google with auth and parses choices[].message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify({ save: true, bullets: ["never discuss budget"] }) } }
        ]
      })
    });
    const res = await extractOwnerRule({
      ownerMessage: "from now on never discuss budget",
      model: "gemini-2.5-flash-lite",
      ollamaBaseUrl: base,
      geminiBaseUrl: `${gemini}/`,
      geminiApiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(res).toEqual({ save: true, bullets: ["never discuss budget"] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${gemini}/chat/completions`);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gemini-2.5-flash-lite");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.messages[1].content).toContain("from now on never discuss budget");
  });

  it("returns a no-op for a gemini-* model when the API key is missing", async () => {
    const fetchImpl = vi.fn();
    const res = await extractOwnerRule({
      ownerMessage: "never discuss budget",
      model: "gemini-2.5-flash-lite",
      ollamaBaseUrl: base,
      geminiBaseUrl: gemini,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(res).toEqual({ save: false, bullets: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a no-op for a gemini-* model when the base URL is missing", async () => {
    const fetchImpl = vi.fn();
    const res = await extractOwnerRule({
      ownerMessage: "never discuss budget",
      model: "gemini-2.5-flash-lite",
      geminiApiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(res).toEqual({ save: false, bullets: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
