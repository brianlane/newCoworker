import { beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = {
  data?: unknown;
  error?: { message: string } | null;
};

function makeBuilder(result: StubResult) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "insert", "update", "delete", "upsert", "order", "limit"]) {
    b[m] = vi.fn(() => b);
  }
  b.single = vi.fn(async () => result);
  b.maybeSingle = vi.fn(async () => result);
  b.then = (resolve: (v: StubResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return b;
}

const supabaseStub = { from: vi.fn(), rpc: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseStub)
}));

const findAuthUserIdByEmail = vi.fn();
vi.mock("@/lib/auth", () => ({
  findAuthUserIdByEmail: (...args: unknown[]) => findAuthUserIdByEmail(...args)
}));

import {
  getContactLanguage,
  persistDetectedContactLanguage,
  setContactLanguageOwnerOverride
} from "@/lib/db/contact-language";
import { getUserUiLocale, setUserUiLocale } from "@/lib/db/user-preferences";
import { emailMessagesForLocale } from "@/lib/i18n/email-copy";
import { formatPricePerMonthLocalized, intlLocaleForApp } from "@/lib/i18n/format";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { localeCookieValue, resolveUiLocale } from "@/lib/i18n/resolve-locale";
import { isSpanishMarketingPath, stripSpanishPrefix } from "@/lib/i18n/es-routes";
import { buildProvisioningLiveEmail } from "@/lib/email/templates/provisioning-live";

const BIZ = "11111111-1111-4111-8111-111111111111";
const E164 = "+16025550100";
const USER = "22222222-2222-4222-8222-222222222222";
const injected = supabaseStub as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("contact-language db", () => {
  it("getContactLanguage returns stored values", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { preferred_language: "es", language_source: "detected" }, error: null })
    );
    const row = await getContactLanguage(BIZ, E164);
    expect(row).toEqual({ preferred_language: "es", language_source: "detected" });
  });

  it("getContactLanguage returns nulls when no row", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    const row = await getContactLanguage(BIZ, E164, injected);
    expect(row).toEqual({ preferred_language: null, language_source: null });
  });

  it("getContactLanguage throws on error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "boom" } }));
    await expect(getContactLanguage(BIZ, E164, injected)).rejects.toThrow("boom");
  });

  it("setContactLanguageOwnerOverride writes owner_set", async () => {
    const builder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await setContactLanguageOwnerOverride(BIZ, E164, "es");
    expect(builder.update).toHaveBeenCalledWith({
      preferred_language: "es",
      language_source: "owner_set"
    });
  });

  it("setContactLanguageOwnerOverride clears when language null", async () => {
    const builder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await setContactLanguageOwnerOverride(BIZ, E164, null, injected);
    expect(builder.update).toHaveBeenCalledWith({
      preferred_language: null,
      language_source: null
    });
  });

  it("setContactLanguageOwnerOverride throws on error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ error: { message: "nope" } }));
    await expect(setContactLanguageOwnerOverride(BIZ, E164, "en", injected)).rejects.toThrow(
      "nope"
    );
  });

  it("persistDetectedContactLanguage skips when owner_set", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { preferred_language: "en", language_source: "owner_set" }, error: null })
    );
    await persistDetectedContactLanguage(BIZ, E164, "es", injected);
    // Only the read happened — no update call issued.
    expect(supabaseStub.from).toHaveBeenCalledTimes(1);
  });

  it("persistDetectedContactLanguage writes detected language", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { preferred_language: null, language_source: null }, error: null })
    );
    const writeBuilder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(writeBuilder);
    await persistDetectedContactLanguage(BIZ, E164, "es");
    expect(writeBuilder.update).toHaveBeenCalledWith({
      preferred_language: "es",
      language_source: "detected"
    });
  });

  it("persistDetectedContactLanguage throws on write error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ error: { message: "write failed" } }));
    await expect(persistDetectedContactLanguage(BIZ, E164, "en", injected)).rejects.toThrow(
      "write failed"
    );
  });
});

describe("user-preferences db", () => {
  it("getUserUiLocale returns saved es", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { ui_locale: "es" }, error: null })
    );
    expect(await getUserUiLocale(USER)).toBe("es");
  });

  it("getUserUiLocale defaults on unknown value", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { ui_locale: "fr" }, error: null })
    );
    expect(await getUserUiLocale(USER, injected)).toBe("en");
  });

  it("getUserUiLocale defaults to en on db error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "down" } }));
    expect(await getUserUiLocale(USER, injected)).toBe("en");
  });

  it("getUserUiLocale defaults to en on a non-Error throw", async () => {
    supabaseStub.from.mockImplementationOnce(() => {
      throw "raw string failure";
    });
    expect(await getUserUiLocale(USER, injected)).toBe("en");
  });

  it("setUserUiLocale upserts the row", async () => {
    const builder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await setUserUiLocale(USER, "es");
    expect(builder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER, ui_locale: "es" }),
      { onConflict: "user_id" }
    );
  });

  it("setUserUiLocale throws on error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ error: { message: "denied" } }));
    await expect(setUserUiLocale(USER, "en", injected)).rejects.toThrow("denied");
  });
});

describe("owner-locale resolution", () => {
  it("defaults to en when email is empty", async () => {
    expect(await resolveOwnerUiLocaleForEmail(null)).toBe("en");
    expect(await resolveOwnerUiLocaleForEmail("  ")).toBe("en");
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
  });

  it("defaults to en when no auth user matches", async () => {
    findAuthUserIdByEmail.mockResolvedValueOnce(null);
    expect(await resolveOwnerUiLocaleForEmail("owner@example.com")).toBe("en");
  });

  it("returns the saved locale for a matched user", async () => {
    findAuthUserIdByEmail.mockResolvedValueOnce(USER);
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { ui_locale: "es" }, error: null })
    );
    expect(await resolveOwnerUiLocaleForEmail("Owner@Example.com")).toBe("es");
    expect(findAuthUserIdByEmail).toHaveBeenCalledWith("owner@example.com");
  });

  it("defaults to en when lookup throws", async () => {
    findAuthUserIdByEmail.mockRejectedValueOnce(new Error("auth down"));
    expect(await resolveOwnerUiLocaleForEmail("owner@example.com")).toBe("en");
  });
});

describe("resolve-locale helpers", () => {
  it("prefers saved preference, then cookie, then default (never Accept-Language)", () => {
    expect(
      resolveUiLocale({ savedPreference: "es", cookieLocale: "en", acceptLanguage: "en-US" })
    ).toBe("es");
    expect(resolveUiLocale({ cookieLocale: "es", acceptLanguage: "en-US" })).toBe("es");
    expect(resolveUiLocale({ acceptLanguage: "es-MX" })).toBe("en");
  });

  it("localeCookieValue returns the cookie tuple", () => {
    expect(localeCookieValue("es")).toEqual({ name: "NEXT_LOCALE", value: "es" });
  });
});

describe("es SEO route helpers", () => {
  it("matches /es marketing mirrors only", () => {
    expect(isSpanishMarketingPath("/es")).toBe(true);
    expect(isSpanishMarketingPath("/es/pricing")).toBe(true);
    expect(isSpanishMarketingPath("/es/onboard/questionnaire")).toBe(true);
    expect(isSpanishMarketingPath("/es/dashboard")).toBe(false);
    expect(isSpanishMarketingPath("/pricing")).toBe(false);
    expect(isSpanishMarketingPath("/especial")).toBe(false);
  });

  it("strips the /es prefix", () => {
    expect(stripSpanishPrefix("/es")).toBe("/");
    expect(stripSpanishPrefix("/es/pricing")).toBe("/pricing");
    expect(stripSpanishPrefix("/pricing")).toBe("/pricing");
  });
});

describe("i18n format helpers", () => {
  it("maps app locales to Intl locales", () => {
    expect(intlLocaleForApp("en")).toBe("en-US");
    expect(intlLocaleForApp("es")).toBe("es-US");
  });

  it("formats whole and fractional dollar amounts per locale", () => {
    expect(formatPricePerMonthLocalized(20000, "en")).toBe("$200");
    expect(formatPricePerMonthLocalized(1999, "en")).toBe("$19.99");
    expect(formatPricePerMonthLocalized(100000, "es")).toMatch(/^\$1[.,]000$/);
  });
});

describe("email copy locale", () => {
  it("returns Spanish and English bundles", () => {
    expect(emailMessagesForLocale("es").provisioningLive.subject).toContain("vivo");
    expect(emailMessagesForLocale("en").provisioningLive.subject).toContain("live");
  });

  it("provisioning-live email renders per locale and defaults to en", () => {
    const base = {
      dashboardUrl: "https://app.example.com/dashboard",
      siteUrl: "https://app.example.com",
      recipientEmail: "owner@example.com"
    };
    const es = buildProvisioningLiveEmail({ ...base, locale: "es" });
    expect(es.subject).toContain("vivo");
    const def = buildProvisioningLiveEmail(base);
    expect(def.subject).toBe("Your AI Coworker is live!");
    expect(def.text).toContain(base.dashboardUrl);
  });
});
