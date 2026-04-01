import { afterEach, describe, expect, it } from "vitest";

import { checkEnv, getEnvDisplayValue } from "@/lib/admin/system";

describe("admin system page env display", () => {
  const originalTestEnvValue = process.env.TEST_ENV_VALUE;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    process.env.TEST_ENV_VALUE = originalTestEnvValue;
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  it("treats whitespace-only environment values as unset", () => {
    process.env.TEST_ENV_VALUE = "   ";

    expect(checkEnv("TEST_ENV_VALUE")).toBe(false);
  });

  it("never exposes partial secret values in the UI label", () => {
    process.env.OPENAI_API_KEY = "sk-live-super-secret-material";

    expect(checkEnv("OPENAI_API_KEY")).toBe(true);
    expect(getEnvDisplayValue(true)).toBe("configured");
    expect(getEnvDisplayValue(true)).not.toContain("sk-live");
    expect(getEnvDisplayValue(false)).toBe("not set");
  });
});
