import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return {
    ...actual,
    rateLimitDurable: vi.fn()
  };
});

process.env.ORkey = "test-openrouter-key";

import { POST } from "@/app/api/onboard/chat/route";
import { MAX_ONBOARDING_CHAT_MESSAGES, ONBOARDING_CHAT_RESPONSE_JSON_SCHEMA } from "@/lib/onboarding/chat";
import { rateLimitDurable } from "@/lib/rate-limit";

const PRIMARY_MODEL = "deepseek/deepseek-v4-flash-0731";
const FALLBACK_MODEL = "openai/gpt-5.4-nano";

const EMPTY_PROFILE = {
  businessSummary: "",
  serviceArea: "",
  teamSize: "",
  crmUsed: [],
  offerings: [],
  customerTypes: [],
  commonRequests: [],
  inquiryFlows: [],
  routingRules: [],
  schedulingRules: [],
  escalationRules: [],
  tools: [],
  toneDirectives: [],
  signature: "",
  policies: [],
  factsToRemember: []
};

/** A model payload that satisfies `onboardingChatModelResponseSchema`. */
function modelPayload(overrides: Record<string, unknown> = {}) {
  return {
    assistantMessage: "What types of customers usually reach out first?",
    readyToFinalize: false,
    completionPercent: 20,
    missingTopics: ["customerTypes"],
    profile: EMPTY_PROFILE,
    ...overrides
  };
}

/** An OpenRouter chat-completions envelope wrapping `payload` as the model's content. */
function openRouterEnvelope(
  payload: unknown,
  opts: { finishReason?: string; provider?: string; usage?: unknown } = {}
) {
  return {
    provider: opts.provider ?? "Fireworks",
    choices: [
      {
        finish_reason: opts.finishReason ?? "stop",
        message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) }
      }
    ],
    usage: opts.usage ?? {
      prompt_tokens: 1200,
      completion_tokens: 180,
      total_tokens: 1380,
      cost: 0.000123,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 0 }
    }
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function request(body: Record<string, unknown> = {}) {
  return new Request("http://localhost:3000/api/onboard/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessName: "Acme Plumbing",
      messages: [{ role: "user", content: "Start the onboarding interview." }],
      ...body
    })
  });
}

/** Parsed request bodies OpenRouter was called with, in attempt order. */
function sentBodies(): Record<string, any>[] {
  return vi.mocked(fetch).mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
}

describe("api/onboard/chat route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(rateLimitDurable).mockResolvedValue({
      success: true,
      limit: 12,
      remaining: 11,
      reset: Date.now() + 60000
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("happy path", () => {
    it("serves the turn from the primary model without touching the fallback", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.assistantMessage).toContain("customers");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sentBodies()[0].model).toBe(PRIMARY_MODEL);
    });

    it("compiles the Rowboat markdown drafts onto the response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));

      const body = await (await POST(request())).json();

      expect(body.data.drafts).toEqual(
        expect.objectContaining({
          identityMd: expect.any(String),
          soulMd: expect.any(String),
          memoryMd: expect.any(String)
        })
      );
    });

    it("requests strict json_schema rather than loose json_object", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));
      await POST(request());

      const sent = sentBodies()[0];
      expect(sent.response_format.type).toBe("json_schema");
      expect(sent.response_format.json_schema).toEqual(ONBOARDING_CHAT_RESPONSE_JSON_SCHEMA);
      expect(sent.response_format.json_schema.strict).toBe(true);
    });

    it("pins routing to zero-retention providers without over-constraining parameters", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));
      await POST(request());

      const sent = sentBodies()[0];
      expect(sent.provider).toEqual({ data_collection: "deny", zdr: true });
      // `require_parameters: true` empties the endpoint pool on both models,
      // because no OpenAI GPT-5.x endpoint declares `temperature` and no DeepSeek
      // endpoint declares `max_completion_tokens`. Both are still honoured, so the
      // flag would only exclude working endpoints. Guard against a well-meaning
      // future re-add.
      expect(sent.provider).not.toHaveProperty("require_parameters");
    });

    it("logs one telemetry line carrying usage, provider and attempt", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        okResponse(openRouterEnvelope(modelPayload(), { provider: "DeepInfra" }))
      );

      await POST(request());

      expect(console.info).toHaveBeenCalledWith(
        "[onboard/chat] openrouter turn served",
        expect.objectContaining({
          model: PRIMARY_MODEL,
          attempt: 1,
          provider: "DeepInfra",
          finishReason: "stop",
          promptTokens: 1200,
          completionTokens: 180,
          totalTokens: 1380,
          cachedTokens: 400,
          reasoningTokens: 0,
          costUsd: 0.000123
        })
      );
    });

    it("omits token fields rather than logging NaN when usage is absent", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        okResponse({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(modelPayload()) } }]
        })
      );

      await POST(request());

      expect(console.info).toHaveBeenCalledWith(
        "[onboard/chat] openrouter turn served",
        expect.objectContaining({
          promptTokens: undefined,
          costUsd: undefined,
          provider: undefined
        })
      );
    });

    it("never logs the model's response body, which restates user business context", async () => {
      const secret = "Owner is Brian Lane, reachable at 16026866672";
      vi.mocked(fetch).mockResolvedValueOnce(
        okResponse(openRouterEnvelope(modelPayload({ assistantMessage: `${secret}. Who handles calls?` })))
      );

      await POST(request());

      const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
      expect(logged).not.toContain(secret);
    });
  });

  describe("model fallover", () => {
    it("falls over to the fallback model on an HTTP 429", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { code: 429, message: "Provider returned error" } }), { status: 429 })
        )
        .mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sentBodies().map((b) => b.model)).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);
    });

    it("falls over when the primary attempt aborts on the per-attempt timeout", async () => {
      const abortError = new Error("The operation was aborted.");
      abortError.name = "AbortError";
      vi.mocked(fetch)
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(console.error).toHaveBeenCalledWith(
        "[onboard/chat] openrouter request failed",
        expect.objectContaining({ model: PRIMARY_MODEL, attempt: 1, timedOut: true })
      );
    });

    it("falls over when the primary returns non-JSON content", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(okResponse(openRouterEnvelope("I am afraid I cannot do that.")))
        .mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(console.error).toHaveBeenCalledWith(
        "[onboard/chat] openrouter parse failed",
        expect.objectContaining({ model: PRIMARY_MODEL, attempt: 1, errorType: "parse_error" })
      );
    });

    it("falls over when the primary returns JSON that misses a required field", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(okResponse(openRouterEnvelope({ readyToFinalize: false })))
        .mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(console.error).toHaveBeenCalledWith(
        "[onboard/chat] openrouter parse failed",
        expect.objectContaining({ attempt: 1, errorType: "schema_mismatch" })
      );
    });

    it("attributes the fallback turn as attempt 2 in telemetry", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response("{}", { status: 500 }))
        .mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload(), { provider: "Azure" })));

      await POST(request());

      expect(console.info).toHaveBeenCalledWith(
        "[onboard/chat] openrouter turn served",
        expect.objectContaining({ model: FALLBACK_MODEL, attempt: 2, provider: "Azure" })
      );
    });

    it("returns the friendly error, not a stack, when both models fail", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response("{}", { status: 500 }))
        .mockResolvedValueOnce(new Response("{}", { status: 500 }));

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.message).toContain("briefly unavailable");
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("truncation handling", () => {
    it("keeps a schema-valid payload even when finish_reason is length", async () => {
      // Providers stamp `length` whenever the cap is reached, including when the
      // JSON happened to complete. Discarding those would force a needless fallover.
      vi.mocked(fetch).mockResolvedValueOnce(
        okResponse(openRouterEnvelope(modelPayload(), { finishReason: "length" }))
      );

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("reports truncated, not invalid_json, when length output also fails to parse", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          okResponse(openRouterEnvelope('{"assistantMessage":"half a sen', { finishReason: "length" }))
        )
        .mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));

      await POST(request());

      expect(console.error).toHaveBeenCalledWith(
        "[onboard/chat] openrouter parse failed",
        expect.objectContaining({ errorType: "truncated" })
      );
    });

    it("treats an empty body with finish_reason length as truncation", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(okResponse(openRouterEnvelope("", { finishReason: "length" })))
        .mockResolvedValueOnce(okResponse(openRouterEnvelope(modelPayload())));

      await POST(request());

      expect(console.error).toHaveBeenCalledWith(
        "[onboard/chat] openrouter parse failed",
        expect.objectContaining({ errorType: "truncated" })
      );
    });
  });

  describe("deterministic server-side guards", () => {
    it("swaps a dead-end message for a concrete next question", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        okResponse(
          openRouterEnvelope(
            modelPayload({ assistantMessage: "Great, we should be ready to finalize soon." })
          )
        )
      );

      const body = await (await POST(request())).json();

      expect(body.data.readyToFinalize).toBe(false);
      expect(body.data.assistantMessage).toContain("?");
    });

    it("finalizes instead of asking when a dead-end lands with every topic covered", async () => {
      const covered = {
        ...EMPTY_PROFILE,
        businessSummary: "Plumbing company in Phoenix",
        customerTypes: ["Homeowners"],
        commonRequests: ["Emergency leak"],
        inquiryFlows: [{ trigger: "Leak call", responseGoal: "Book a visit" }],
        routingRules: ["Send to Brian"],
        toneDirectives: ["Warm", "Brief"],
        policies: ["No weekend rates"],
        factsToRemember: ["Licensed in AZ"]
      };
      vi.mocked(fetch).mockResolvedValueOnce(
        okResponse(
          openRouterEnvelope(
            modelPayload({ assistantMessage: "Thanks, that covers everything.", profile: covered })
          )
        )
      );

      const body = await (await POST(request())).json();

      expect(body.data.readyToFinalize).toBe(true);
      // Finalizing clamps the stale progress metadata from the previous turn.
      expect(body.data.completionPercent).toBe(100);
      expect(body.data.missingTopics).toEqual([]);
    });

    it("replaces a repeated tools question once the CRM is already known", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        okResponse(
          openRouterEnvelope(
            modelPayload({ assistantMessage: "What tools do you currently use to run the business?" })
          )
        )
      );

      const body = await (await POST(request({ crmUsed: "HubSpot" }))).json();

      expect(body.data.assistantMessage).not.toMatch(/what tools do you currently use/i);
      expect(body.data.assistantMessage).toContain("?");
    });
  });

  describe("pre-flight guards", () => {
    it("rejects the turn when the caller is rate limited", async () => {
      vi.mocked(rateLimitDurable).mockResolvedValue({
        success: false,
        limit: 12,
        remaining: 0,
        reset: Date.now() + 60000
      });

      const response = await POST(request());

      expect(response.status).toBe(429);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("stops the interview at the message cap before spending a token", async () => {
      const messages = Array.from({ length: MAX_ONBOARDING_CHAT_MESSAGES }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn ${index}`
      }));

      const response = await POST(request({ messages }));

      expect(response.status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects an oversized website summary rather than burning input tokens on it", async () => {
      const response = await POST(request({ websiteMd: "x".repeat(16_001) }));

      expect(response.status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("fails clearly when no OpenRouter key is configured", async () => {
      const savedKey = process.env.ORkey;
      const savedAlias = process.env.OPENROUTER_API_KEY;
      delete process.env.ORkey;
      delete process.env.OPENROUTER_API_KEY;

      try {
        const response = await POST(request());
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error.message).toContain("OpenRouter API key");
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        if (savedKey !== undefined) process.env.ORkey = savedKey;
        if (savedAlias !== undefined) process.env.OPENROUTER_API_KEY = savedAlias;
      }
    });
  });
});
