import { describe, expect, it } from "vitest";
import { smokeTestGeminiSummarizeConnectivity } from "@/lib/website-ingest";

/** Not included in CI: see `vitest.config.ts` `exclude`; run manually via `npm run test:gemini-live`. */
describe("Gemini generateContent live ping", () => {
  it(
    "receives OK_GEMINI_SMOKE from generativelanguage.googleapis.com generateContent",
    async () => {
      if (!(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY)) {
        throw new Error("Set GOOGLE_API_KEY or GEMINI_API_KEY in the environment.");
      }
      const out = await smokeTestGeminiSummarizeConnectivity();
      expect(out).toMatch(/OK_GEMINI_SMOKE/i);
    },
    35_000
  );
});
