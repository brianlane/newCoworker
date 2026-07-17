import { describe, expect, it } from "vitest";
import { resolveUiLocale } from "@/lib/i18n/resolve-locale";

describe("resolveUiLocale", () => {
  it("defaults to English with no preference or cookie", () => {
    expect(resolveUiLocale({})).toBe("en");
  });

  it("never uses Accept-Language even when Spanish is preferred in browser", () => {
    expect(
      resolveUiLocale({
        acceptLanguage: "es-MX,es;q=0.9,en;q=0.8"
      })
    ).toBe("en");
  });

  it("uses saved user preference over cookie", () => {
    expect(
      resolveUiLocale({
        savedPreference: "es",
        cookieLocale: "en"
      })
    ).toBe("es");
  });

  it("uses cookie when no saved preference", () => {
    expect(resolveUiLocale({ cookieLocale: "es" })).toBe("es");
  });
});
