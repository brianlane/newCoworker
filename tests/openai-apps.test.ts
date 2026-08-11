import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_APPS_CHALLENGE_PATH,
  openAiAppsChallengeToken
} from "@/lib/marketing/openai-apps";
import { GET as challengeGet } from "@/app/.well-known/openai-apps-challenge/route";

// Deliberately a readable placeholder, not a realistic token. A random-looking
// literal here trips GitGuardian's high-entropy detector, and a test fixture is
// not worth teaching the scanner to ignore this file.
const TOKEN = "openai-apps-challenge-example-token";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

beforeEach(() => {
  vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("openAiAppsChallengeToken", () => {
  it("reads the env token, trimmed", () => {
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", `  ${TOKEN}\n`);
    expect(openAiAppsChallengeToken()).toBe(TOKEN);
  });

  it("is null when unset or blank, which turns the feature off", () => {
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "");
    expect(openAiAppsChallengeToken()).toBeNull();
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "   ");
    expect(openAiAppsChallengeToken()).toBeNull();
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", undefined);
    expect(openAiAppsChallengeToken()).toBeNull();
  });

  it("refuses a value with interior whitespace, which means a list or a wrapped line", async () => {
    const { logger } = await import("@/lib/logger");
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "token-one token-two");
    expect(openAiAppsChallengeToken()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("whitespace"));
  });

  it("refuses a pasted JSON blob, which minifies to zero whitespace", async () => {
    const { logger } = await import("@/lib/logger");
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", `{"token":"${TOKEN}"}`);
    expect(openAiAppsChallengeToken()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("JSON"));

    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", `["${TOKEN}"]`);
    expect(openAiAppsChallengeToken()).toBeNull();
  });

  it("refuses an implausible length at both ends", async () => {
    const { logger } = await import("@/lib/logger");
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "short");
    expect(openAiAppsChallengeToken()).toBeNull();
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "a".repeat(257));
    expect(openAiAppsChallengeToken()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("length"));
  });

  it("accepts the boundary lengths", () => {
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "a".repeat(8));
    expect(openAiAppsChallengeToken()).toBe("a".repeat(8));
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "a".repeat(256));
    expect(openAiAppsChallengeToken()).toBe("a".repeat(256));
  });

  it("pins the path OpenAI's portal shows as the challenge URL", () => {
    expect(OPENAI_APPS_CHALLENGE_PATH).toBe("/.well-known/openai-apps-challenge");
  });
});

describe("GET /.well-known/openai-apps-challenge", () => {
  it("serves the bare token as plain text, uncached", async () => {
    const res = challengeGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The body must be the token and nothing else: no JSON, no trailing newline.
    expect(await res.text()).toBe(TOKEN);
  });

  it("404s when the token is unset, so the feature reads as off, not broken", async () => {
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "");
    const res = challengeGet();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("404s rather than serving a value OpenAI would reject", async () => {
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", `{"token":"${TOKEN}"}`);
    expect(challengeGet().status).toBe(404);
  });
});
