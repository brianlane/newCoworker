/**
 * Prospecting owner surface (src/lib/outreach/owner.ts): the read model behind
 * the dashboard panel, the settings validation that refuses a configuration the
 * sweep could not honor, and what Skip means.
 *
 * The postal-address rule gets its own test because it is a legal requirement
 * rather than a preference: switching outreach on without one has to fail here
 * with a readable message, in front of the database constraint that makes it
 * impossible.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

const getOutreachSettingsSpy = vi.fn();
const listProspectOutcomesSpy = vi.fn(async () => []);
const listProspectsByStatusSpy = vi.fn(async () => []);
const upsertOutreachSettingsSpy = vi.fn(
  async (_businessId: string, _patch: { search_terms: string[]; cities: string[] }) => ({
    business_id: "b",
    mode: "manual"
  })
);
const transitionProspectSpy = vi.fn(async () => true);
const prospectingAllowedSpy = vi.fn(async () => true);
vi.mock("@/lib/plans/prospecting", () => ({
  PROSPECTING_UPGRADE_MESSAGE:
    "Prospecting is a Standard plan perk. Upgrade to have your coworker find local businesses and email them for you.",
  prospectingAllowedForBusiness: (...a: unknown[]) => prospectingAllowedSpy(...(a as [])),
  prospectingAllowedForTier: (tier: string | null | undefined) =>
    tier === "standard" || tier === "enterprise"
}));
vi.mock("@/lib/outreach/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getOutreachSettings: (...a: unknown[]) => getOutreachSettingsSpy(...(a as [])),
    listProspectOutcomes: (...a: unknown[]) => listProspectOutcomesSpy(...(a as [])),
    listProspectsByStatus: (...a: unknown[]) => listProspectsByStatusSpy(...(a as [])),
    upsertOutreachSettings: (...a: unknown[]) =>
      upsertOutreachSettingsSpy(
        ...(a as unknown as Parameters<typeof upsertOutreachSettingsSpy>)
      ),
    transitionProspect: (...a: unknown[]) => transitionProspectSpy(...(a as []))
  };
});

import { OUTREACH_SCAN_LIMIT } from "@/lib/outreach/db";
import {
  defaultProspectingSettings,
  describeBlockers,
  loadProspectingView,
  MAX_CITIES,
  MAX_DAILY_CAP,
  MAX_SEARCH_TERMS,
  ProspectingSettingsError,
  REVIEW_QUEUE_LIMIT,
  saveProspectingSettings,
  skipProspect,
  type ProspectingSettingsInput
} from "@/lib/outreach/owner";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PROSPECT = "22222222-2222-4222-8222-222222222222";

function settingsRow(over: Record<string, unknown> = {}) {
  return {
    business_id: BIZ,
    mode: "auto",
    search_terms: ["hvac"],
    cities: ["Phoenix"],
    daily_cap: 12,
    send_window_start_hour: 8,
    send_window_end_hour: 11,
    from_connection_id: null,
    postal_address: "1 Example Plaza",
    value_prop: "We answer every call.",
    sender_name: "Brian",
    last_discovery_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...over
  };
}

function input(over: Partial<ProspectingSettingsInput> = {}): ProspectingSettingsInput {
  return {
    mode: "auto",
    searchTerms: ["hvac"],
    cities: ["Phoenix"],
    dailyCap: 12,
    sendWindowStartHour: 8,
    sendWindowEndHour: 11,
    postalAddress: "1 Example Plaza",
    valueProp: "We answer every call.",
    senderName: "Brian",
    ...over
  };
}

// loadProspectingView reads the Places key from the process env, so pin it
// per test rather than inheriting whatever the runner's environment has.
const ORIGINAL_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
afterAll(() => {
  if (ORIGINAL_PLACES_KEY === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = ORIGINAL_PLACES_KEY;
});

beforeEach(() => {
  vi.clearAllMocks();
  getOutreachSettingsSpy.mockResolvedValue(settingsRow());
  transitionProspectSpy.mockResolvedValue(true);
  prospectingAllowedSpy.mockResolvedValue(true);
  process.env.GOOGLE_PLACES_API_KEY = "places-key";
});

describe("loadProspectingView", () => {
  it("reads settings, funnel, and the review queue in one pass", async () => {
    listProspectOutcomesSpy.mockResolvedValue([
      { status: "sent", vertical: "hvac" },
      { status: "replied", vertical: "hvac" },
      { status: "drafted", vertical: "roofing" }
    ] as never);
    listProspectsByStatusSpy.mockResolvedValue([{ id: PROSPECT }] as never);

    const view = await loadProspectingView(BIZ, {} as never);
    expect(view.settings).toMatchObject({ mode: "auto" });
    expect(view.funnel).toMatchObject({ sent: 2, replied: 1, drafted: 3, pending: 1 });
    expect(view.byVertical.map((v) => v.vertical)).toEqual(["hvac", "roofing"]);
    expect(view.queue).toHaveLength(1);
    expect(view.blockers).toEqual([]);
    expect(view.clipped).toBe(false);
    expect(view.tierAllowed).toBe(true);
    // The queue is bounded: a big backlog must not become a huge payload.
    expect(listProspectsByStatusSpy).toHaveBeenCalledWith(
      BIZ,
      ["drafted"],
      REVIEW_QUEUE_LIMIT,
      expect.anything()
    );
  });

  it("reports tierAllowed false when Prospecting is not on the plan", async () => {
    prospectingAllowedSpy.mockResolvedValue(false);
    listProspectOutcomesSpy.mockResolvedValue([] as never);
    listProspectsByStatusSpy.mockResolvedValue([] as never);
    const view = await loadProspectingView(BIZ, {} as never);
    expect(view.tierAllowed).toBe(false);
  });

  it("degrades rather than 500s the panel when the tier lookup fails", async () => {
    // tierAllowed is display-only (the upgrade card); every write path
    // re-checks the tier server-side. A transient businesses read failure
    // must not take down the whole Marketing panel, and it must not flash
    // an upgrade card at a paying tenant, so the degraded value is true.
    prospectingAllowedSpy.mockRejectedValue(new Error("transient read failure"));
    listProspectOutcomesSpy.mockResolvedValue([] as never);
    listProspectsByStatusSpy.mockResolvedValue([] as never);
    const view = await loadProspectingView(BIZ, {} as never);
    expect(view.tierAllowed).toBe(true);

    // Same degrade when the rejection is not an Error instance.
    prospectingAllowedSpy.mockRejectedValue("plain string blip");
    const again = await loadProspectingView(BIZ, {} as never);
    expect(again.tierAllowed).toBe(true);
  });

  it("flags a clipped scan rather than under-reporting the funnel", async () => {
    // A tenant with more prospects than the scan bound would otherwise see
    // totals and a reply rate that quietly stop counting.
    listProspectOutcomesSpy.mockResolvedValue(
      Array.from({ length: OUTREACH_SCAN_LIMIT }, () => ({
        status: "sent",
        vertical: "hvac"
      })) as never
    );
    listProspectsByStatusSpy.mockResolvedValue([] as never);
    const view = await loadProspectingView(BIZ, {} as never);
    expect(view.clipped).toBe(true);
    expect(view.funnel.sent).toBe(OUTREACH_SCAN_LIMIT);
  });

  it("surfaces a missing platform Places key as the first blocker", async () => {
    // This exact absence once no-oped discovery silently for days; the page
    // must say so instead of looking like a quiet day.
    delete process.env.GOOGLE_PLACES_API_KEY;
    listProspectOutcomesSpy.mockResolvedValue([] as never);
    listProspectsByStatusSpy.mockResolvedValue([] as never);
    const view = await loadProspectingView(BIZ, {} as never);
    expect(view.blockers).toEqual(["placesKey"]);
  });

  it("treats a blank platform Places key the same as a missing one", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "   ";
    listProspectOutcomesSpy.mockResolvedValue([] as never);
    listProspectsByStatusSpy.mockResolvedValue([] as never);
    const view = await loadProspectingView(BIZ, {} as never);
    expect(view.blockers).toEqual(["placesKey"]);
  });

  it("works through the default client and reports a never-configured business", async () => {
    getOutreachSettingsSpy.mockResolvedValue(null);
    listProspectOutcomesSpy.mockResolvedValue([] as never);
    listProspectsByStatusSpy.mockResolvedValue([] as never);
    defaultClientSpy.mockReturnValue({});
    const view = await loadProspectingView(BIZ);
    expect(view.settings).toBeNull();
    // No row means off, which is not a blocker, it is the default.
    expect(view.blockers).toEqual([]);
    expect(view.funnel.discovered).toBe(0);
  });
});

describe("describeBlockers", () => {
  it("names every missing precondition, as the action that clears it", () => {
    expect(
      describeBlockers(
        settingsRow({
          postal_address: null,
          value_prop: "   ",
          search_terms: [],
          cities: []
        }) as never
      )
    ).toEqual(["postalAddress", "valueProp", "searchTerms", "cities"]);
    expect(describeBlockers(settingsRow() as never)).toEqual([]);
    expect(describeBlockers(null)).toEqual([]);
  });

  it("flags the platform Places key only when explicitly reported missing", () => {
    expect(describeBlockers(settingsRow() as never, { placesKeyConfigured: false })).toEqual([
      "placesKey"
    ]);
    expect(describeBlockers(settingsRow() as never, { placesKeyConfigured: true })).toEqual([]);
    // Callers that do not assert the key (the default) see no change.
    expect(describeBlockers(settingsRow() as never, {})).toEqual([]);
    // Never opened means off, which stays blocker-free whatever the env.
    expect(describeBlockers(null, { placesKeyConfigured: false })).toEqual([]);
    // The platform gap outranks the owner's own preconditions.
    expect(
      describeBlockers(settingsRow({ postal_address: null }) as never, {
        placesKeyConfigured: false
      })
    ).toEqual(["placesKey", "postalAddress"]);
  });
});

describe("saveProspectingSettings", () => {
  it("saves, trimming and de-duping the targeting lists", async () => {
    await saveProspectingSettings(
      BIZ,
      input({ searchTerms: [" hvac ", "HVAC", "plumber", ""], cities: ["Phoenix", "phoenix"] }),
      {} as never
    );
    expect(upsertOutreachSettingsSpy).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        mode: "auto",
        // Case-insensitive de-dupe: each pair is a paid Places query.
        search_terms: ["hvac", "plumber"],
        cities: ["Phoenix"]
      }),
      expect.anything()
    );
  });

  it("refuses to switch on without a postal address or an offer", async () => {
    await expect(
      saveProspectingSettings(BIZ, input({ postalAddress: "   " }), {} as never)
    ).rejects.toThrow(ProspectingSettingsError);
    await expect(
      saveProspectingSettings(BIZ, input({ postalAddress: "" }), {} as never)
    ).rejects.toThrow(/postal address is required/);
    await expect(
      saveProspectingSettings(BIZ, input({ valueProp: " " }), {} as never)
    ).rejects.toThrow(/what the email should offer|what you want the email to offer/i);
    expect(upsertOutreachSettingsSpy).not.toHaveBeenCalled();
  });

  it("allows turning OFF with nothing configured at all", async () => {
    // The owner must always be able to switch it off, whatever state it is in.
    await saveProspectingSettings(
      BIZ,
      input({ mode: "off", postalAddress: "", valueProp: "", searchTerms: [], cities: [] }),
      {} as never
    );
    expect(upsertOutreachSettingsSpy).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ mode: "off", postal_address: null, value_prop: null }),
      expect.anything()
    );
  });

  it("turning OFF is never blocked by a half-typed cap or window", async () => {
    // The panel posts the whole form, so rejecting these on the way out would
    // leave outreach RUNNING until the owner fixed a field they were editing.
    // Off is the one action a form error must not be able to block.
    await saveProspectingSettings(
      BIZ,
      input({ mode: "off", dailyCap: 9999, sendWindowStartHour: 15, sendWindowEndHour: 2 }),
      {} as never
    );
    expect(upsertOutreachSettingsSpy).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        mode: "off",
        // Sanitized, not rejected: meaningless while off, and the schema still
        // requires a legal pair.
        daily_cap: MAX_DAILY_CAP,
        send_window_start_hour: 8,
        send_window_end_hour: 11
      }),
      expect.anything()
    );

    // A negative cap clamps up, and an already-valid window is kept as typed.
    await saveProspectingSettings(
      BIZ,
      input({ mode: "off", dailyCap: -5, sendWindowStartHour: 9, sendWindowEndHour: 17 }),
      {} as never
    );
    expect(upsertOutreachSettingsSpy).toHaveBeenLastCalledWith(
      BIZ,
      expect.objectContaining({
        daily_cap: 0,
        send_window_start_hour: 9,
        send_window_end_hour: 17
      }),
      expect.anything()
    );
  });

  it("refuses an impossible cap or an inverted send window", async () => {
    await expect(saveProspectingSettings(BIZ, input({ dailyCap: -1 }), {} as never)).rejects.toThrow(
      /daily cap/
    );
    await expect(
      saveProspectingSettings(BIZ, input({ dailyCap: MAX_DAILY_CAP + 1 }), {} as never)
    ).rejects.toThrow(/daily cap/);
    await expect(
      saveProspectingSettings(
        BIZ,
        input({ sendWindowStartHour: 11, sendWindowEndHour: 11 }),
        {} as never
      )
    ).rejects.toThrow(/end after it starts/);
  });

  it("caps how many terms and cities can be configured", async () => {
    const many = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    await saveProspectingSettings(
      BIZ,
      input({
        searchTerms: many(MAX_SEARCH_TERMS + 5, "term"),
        cities: many(MAX_CITIES + 5, "city")
      }),
      {} as never
    );
    const saved = upsertOutreachSettingsSpy.mock.calls[0][1];
    expect(saved.search_terms).toHaveLength(MAX_SEARCH_TERMS);
    expect(saved.cities).toHaveLength(MAX_CITIES);
  });

  it("blanks an optional sender name rather than storing whitespace", async () => {
    await saveProspectingSettings(BIZ, input({ senderName: "   " }), {} as never);
    expect(upsertOutreachSettingsSpy).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ sender_name: null }),
      expect.anything()
    );
  });

  it("works through the default client", async () => {
    defaultClientSpy.mockReturnValue({});
    await saveProspectingSettings(BIZ, input());
    expect(upsertOutreachSettingsSpy).toHaveBeenCalled();
  });
});

describe("skipProspect", () => {
  it("retires the draft permanently, which is what keeps the domain out of discovery", async () => {
    expect(await skipProspect(BIZ, PROSPECT, {} as never)).toBe(true);
    expect(transitionProspectSpy).toHaveBeenCalledWith(
      BIZ,
      PROSPECT,
      "drafted",
      { status: "skipped", status_detail: "the owner read the draft and passed" },
      expect.anything()
    );

    defaultClientSpy.mockReturnValue({});
    expect(await skipProspect(BIZ, PROSPECT)).toBe(true);
  });

  it("refuses to skip anything that is no longer a draft", async () => {
    // The queue can be minutes stale: the sweep may have sent this prospect
    // while the page sat open. An unguarded write would mark a real send
    // skipped and quietly remove it from the funnel.
    transitionProspectSpy.mockResolvedValue(false);
    expect(await skipProspect(BIZ, PROSPECT, {} as never)).toBe(false);
  });
});

describe("defaultProspectingSettings", () => {
  it("starts off, with the deliverability-safe cap and a weekday morning window", async () => {
    expect(defaultProspectingSettings()).toEqual({
      mode: "off",
      searchTerms: [],
      cities: [],
      dailyCap: 12,
      sendWindowStartHour: 8,
      sendWindowEndHour: 11,
      postalAddress: "",
      valueProp: "",
      senderName: ""
    });
  });
});
