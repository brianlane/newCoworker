/**
 * The Prospecting sweep (src/lib/outreach/sweep.ts): one pass over every
 * business the feature is on for.
 *
 * The invariants under test are the ones that cost money or credibility:
 * paid Places queries are stamped before they are bought, the send is claimed
 * before the mail leaves, the daily cap and weekday window are obeyed, one
 * nudge per prospect ever, and nothing that cannot be pitched honestly is
 * pitched at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => dbSpy())
}));

const recordSystemLogSpy = vi.fn(async () => {});
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: (...args: unknown[]) => recordSystemLogSpy(...(args as []))
}));

import {
  editProspectDraft,
  MAX_EDITED_BODY_CHARS,
  MAX_EDITED_SUBJECT_CHARS,
  processOutreachSweep,
  recordOutreachEmailLog,
  regenerateProspectDraft,
  sendProspectNow
} from "@/lib/outreach/sweep";
import { PROSPECT_OUTREACH_SOURCE } from "@/lib/ai-flows/templates";
import * as db from "@/lib/outreach/db";
import { OUTREACH_ACTIVE_PAGE_SIZE } from "@/lib/outreach/db";
import type { OutreachProspectRow, OutreachSettingsRow } from "@/lib/outreach/db";

const BIZ = "11111111-1111-4111-8111-111111111111";

/** Monday 09:00 America/Phoenix, inside the default 8 to 11 window. */
const MONDAY_MORNING = new Date("2026-07-27T16:00:00Z");
/** Monday 13:00 Phoenix, past the window. */
const MONDAY_AFTERNOON = new Date("2026-07-27T20:00:00Z");

function settings(over: Partial<OutreachSettingsRow> = {}): OutreachSettingsRow {
  return {
    business_id: BIZ,
    mode: "auto",
    search_terms: ["hvac"],
    cities: ["Phoenix"],
    daily_cap: 12,
    send_window_start_hour: 8,
    send_window_end_hour: 11,
    from_connection_id: null,
    postal_address: "1 Example Plaza, Phoenix AZ",
    postal_address_exempt: false,
    value_prop: "We answer every call and text for you.",
    sender_name: "Brian",
    last_discovery_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...over
  };
}

function prospect(over: Partial<OutreachProspectRow> = {}): OutreachProspectRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    business_id: BIZ,
    domain: "acmehvac.com",
    business_name: "Acme HVAC",
    email: "info@acmehvac.com",
    phone: "(602) 555-0100",
    website: "https://acmehvac.com",
    vertical: "hvac",
    city: "Phoenix",
    google_hours: null,
    rating: null,
    review_count: null,
    findings: [{ code: "no_online_booking", detail: "No booking link." }],
    pitch_subject: "Acme HVAC: booking a job without the phone tag",
    pitch_paragraphs: "Hi Acme HVAC,\n\nbody",
    pitch_body: "Hi Acme HVAC,\n\nbody\n\nunsubscribe",
    status: "drafted",
    status_detail: null,
    contact_id: null,
    drafted_at: "2026-07-27T15:00:00Z",
    queued_at: null,
    sent_at: null,
    nudged_at: null,
    replied_at: null,
    created_at: "2026-07-27T14:00:00Z",
    updated_at: "2026-07-27T15:00:00Z",
    ...over
  };
}

/** Sensible no-op stubs; each test overrides only what it is about. */
function baseDeps(over: Record<string, unknown> = {}) {
  return {
    client: {} as never,
    now: () => MONDAY_MORNING,
    placesApiKey: "places-key",
    appUrl: "https://app.example.com",
    searchPlacesImpl: vi.fn(async () => []),
    probeSiteImpl: vi.fn(async () => ({
      findings: [{ code: "no_online_booking", detail: "No booking link." }],
      email: "info@acmehvac.com",
      reachable: true as const
    })),
    polishImpl: vi.fn(async (_biz: string, paragraphs: string[]) => paragraphs),
    sendEmailImpl: vi.fn(async () => ({
      ok: true as const,
      provider: "google" as const,
      messageId: "msg-1",
      threadId: "thread-1"
    })),
    sendFromConnectionImpl: vi.fn(async () => ({
      ok: true as const,
      provider: "google" as const,
      messageId: "msg-2",
      threadId: "thread-2"
    })),
    getMailboxConnectionImpl: vi.fn(async () => ({
      id: "conn-row",
      connection_id: "nango-conn",
      provider_config_key: "google-mail"
    })),
    rememberThreadImpl: vi.fn(async () => {}),
    getBusinessImpl: vi.fn(async () => ({
      id: BIZ,
      name: "New Coworker",
      timezone: "America/Phoenix",
      website_url: "https://www.newcoworker.com",
      tier: "standard"
    })),
    schedulingLinkImpl: vi.fn(async () => ({
      url: "https://app.example.com/book/hq",
      title: "Book a call",
      meetings: ["Book a call"],
      kind: "booking_page" as const
    })),
    processFlowEventImpl: vi.fn(async () => ({
      enqueued: 1,
      flowsEvaluated: 1,
      flowsMatched: 1
    })),
    recordEmailLogImpl: vi.fn(async () => {}),
    ...over
  } as never;
}

/** Ledger stubs. Each test sets only the calls its phase makes. */
function stubLedger(over: Record<string, unknown> = {}) {
  const defaults = {
    listActiveOutreachSettings: vi.fn(async () => [settings()]),
    claimDiscoveryRun: vi.fn(async () => true),
    getOutreachSettings: vi.fn(async () => settings()),
    getProspect: vi.fn(async () => prospect()),
    upsertOutreachSettings: vi.fn(async () => settings()),
    existingProspectDomains: vi.fn(async () => new Set<string>()),
    insertProspects: vi.fn(async () => []),
    listProspectsByStatus: vi.fn(async () => []),
    listProspectsToProbe: vi.fn(async () => []),
    listProspectsDueForNudge: vi.fn(async () => []),
    patchProspect: vi.fn(async () => true),
    transitionProspect: vi.fn(async () => true),
    claimProspectNudge: vi.fn(async () => true),
    countProspectsSentSince: vi.fn(async () => 0),
    countProspectsNudgedSince: vi.fn(async () => 0),
    ...over
  };
  for (const [name, impl] of Object.entries(defaults)) {
    // Cast through a function-only view of the module: keyof includes the
    // exported constants, which vi.spyOn rightly refuses.
    vi.spyOn(db as unknown as Record<string, () => unknown>, name).mockImplementation(
      impl as never
    );
  }
  return defaults;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("processOutreachSweep: the outer loop", () => {
  it("counts every active business and never lets one failure stop the rest", async () => {
    const other = settings({ business_id: "33333333-3333-4333-8333-333333333333" });
    stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings(), other])
    });
    const getBusinessImpl = vi.fn(async (id: string) => {
      if (id === BIZ) throw new Error("read exploded");
      return { id, name: "Other", timezone: "UTC", website_url: null };
    });
    const result = await processOutreachSweep(baseDeps({ getBusinessImpl }));
    expect(result.businesses).toBe(2);
    expect(result.errors).toEqual([{ businessId: BIZ, message: "read exploded" }]);
    // The failure is recorded where the owner's system log will show it.
    expect(recordSystemLogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, event: "outreach_sweep_failed" }),
      expect.anything()
    );
  });

  it("walks past the first page, so a big fleet is not silently truncated", async () => {
    // A full page means "there may be more". The old single capped read left
    // the tail of the tenant list permanently unswept.
    const page = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) =>
        settings({ business_id: `biz-${offset + i}`, mode: "manual" })
      );
    const listSpy = vi.fn(async (_db: unknown, offset = 0) =>
      offset === 0 ? page(OUTREACH_ACTIVE_PAGE_SIZE, 0) : page(3, 200)
    );
    stubLedger({ listActiveOutreachSettings: listSpy });
    const result = await processOutreachSweep(
      baseDeps({ getBusinessImpl: vi.fn(async () => null) })
    );
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(result.businesses).toBe(OUTREACH_ACTIVE_PAGE_SIZE + 3);
  });

  it("does nothing at all when no business has the feature on", async () => {
    stubLedger({ listActiveOutreachSettings: vi.fn(async () => []) });
    const result = await processOutreachSweep(baseDeps());
    expect(result).toMatchObject({ businesses: 0, discovered: 0, drafted: 0, sent: 0 });
  });

  it("survives a system-log write that itself fails", async () => {
    stubLedger();
    recordSystemLogSpy.mockRejectedValueOnce(new Error("log down"));
    const result = await processOutreachSweep(
      baseDeps({
        getBusinessImpl: vi.fn(async () => {
          throw new Error("boom");
        })
      })
    );
    expect(result.errors).toHaveLength(1);
  });

  it("records a non-Error thrown anywhere in a business's pass", async () => {
    stubLedger();
    const result = await processOutreachSweep(
      baseDeps({
        getBusinessImpl: vi.fn(async () => {
          throw "the database went away";
        })
      })
    );
    expect(result.errors).toEqual([{ businessId: BIZ, message: "the database went away" }]);
  });
});

describe("tenant resolution", () => {
  it("skips Starter businesses without spending Places or sending", async () => {
    stubLedger();
    const searchPlacesImpl = vi.fn(async () => []);
    const result = await processOutreachSweep(
      baseDeps({
        searchPlacesImpl,
        getBusinessImpl: vi.fn(async () => ({
          id: BIZ,
          name: "Starter Co",
          timezone: "America/Phoenix",
          website_url: null,
          tier: "starter"
        }))
      })
    );
    expect(result.notes).toEqual([
      { businessId: BIZ, note: "prospecting requires the Standard plan" }
    ]);
    expect(searchPlacesImpl).not.toHaveBeenCalled();
  });

  it("reports a missing business, postal address, or value proposition as a note", async () => {
    stubLedger();
    const gone = await processOutreachSweep(
      baseDeps({ getBusinessImpl: vi.fn(async () => null) })
    );
    expect(gone.notes).toEqual([{ businessId: BIZ, note: "business row is gone" }]);

    // Blank and absent both count: the DB constraint is the primary gate, this
    // is the belt-and-braces one.
    for (const postal_address of ["  ", null]) {
      stubLedger({
        listActiveOutreachSettings: vi.fn(async () => [settings({ postal_address })])
      });
      const noAddress = await processOutreachSweep(baseDeps());
      expect(noAddress.notes).toEqual([
        { businessId: BIZ, note: "no postal address configured" }
      ]);
    }

    stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ value_prop: null })])
    });
    const noValueProp = await processOutreachSweep(baseDeps());
    expect(noValueProp.notes).toEqual([
      { businessId: BIZ, note: "no value proposition configured" }
    ]);
  });

  it("treats a business with no timezone as UTC for the send window", async () => {
    // 16:00 UTC on a Monday is outside an 8 to 11 window read in UTC, so the
    // absent timezone must not silently become the server's own.
    stubLedger({
      listProspectsByStatus: vi.fn(async (_b: string, statuses: string[]) =>
        statuses.includes("drafted") ? [prospect()] : []
      )
    });
    const result = await processOutreachSweep(
      baseDeps({
        getBusinessImpl: vi.fn(async () => ({
          id: BIZ,
          name: "New Coworker",
          website_url: null,
          tier: "standard"
        }))
      })
    );
    expect(result.sent).toBe(0);
    expect(result.notes).toContainEqual({ businessId: BIZ, note: "outside the send window" });
  });

  it("still runs when the booking-link lookup fails: the pitch just asks for a reply", async () => {
    const ledger = stubLedger({
      listProspectsToProbe: vi.fn(async () => [prospect({ status: "discovered" })])
    });
    const schedulingLinkImpl = vi.fn(async () => {
      throw new Error("calendar down");
    });
    const result = await processOutreachSweep(baseDeps({ schedulingLinkImpl }));
    expect(result.drafted).toBe(1);
    const body = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2]
      .pitch_body as string;
    expect(body).toContain("Just reply if you want to hear more.");
  });
});

describe("phase 1: discovery", () => {
  it("claims the day BEFORE buying queries, so a crash cannot re-buy them", async () => {
    const order: string[] = [];
    const ledger = stubLedger({
      claimDiscoveryRun: vi.fn(async () => {
        order.push("stamp");
        return true;
      }),
      insertProspects: vi.fn(async () => [{ id: "p1" }])
    });
    const searchPlacesImpl = vi.fn(async () => {
      order.push("query");
      return [
        {
          displayName: "Acme HVAC",
          websiteUri: "https://acmehvac.com",
          nationalPhoneNumber: "(602) 555-0100",
          businessStatus: "OPERATIONAL"
        }
      ];
    });
    const result = await processOutreachSweep(baseDeps({ searchPlacesImpl }));
    expect(order[0]).toBe("stamp");
    expect(order).toContain("query");
    expect(result.discovered).toBe(1);
    expect(ledger.claimDiscoveryRun).toHaveBeenCalledWith(
      BIZ,
      MONDAY_MORNING.toISOString(),
      "2026-07-27T00:00:00.000Z",
      expect.anything()
    );
  });

  it("skips domains already in the ledger before they cost a probe", async () => {
    const ledger = stubLedger({
      existingProspectDomains: vi.fn(async () => new Set(["acmehvac.com"]))
    });
    const searchPlacesImpl = vi.fn(async () => [
      {
        displayName: "Acme HVAC",
        websiteUri: "https://acmehvac.com",
        nationalPhoneNumber: "",
        businessStatus: "OPERATIONAL"
      }
    ]);
    await processOutreachSweep(baseDeps({ searchPlacesImpl }));
    expect(ledger.insertProspects).toHaveBeenCalledWith([], expect.anything());
  });

  it("files a phone-less discovery as null, not as a blank", async () => {
    const ledger = stubLedger();
    const searchPlacesImpl = vi.fn(async () => [
      {
        displayName: "Acme HVAC",
        websiteUri: "https://acmehvac.com",
        nationalPhoneNumber: "",
        businessStatus: "OPERATIONAL"
      }
    ]);
    await processOutreachSweep(baseDeps({ searchPlacesImpl }));
    // "Has a phone" stays a single question downstream.
    expect(ledger.insertProspects).toHaveBeenCalledWith(
      [expect.objectContaining({ domain: "acmehvac.com", phone: null })],
      expect.anything()
    );
  });

  it("notes a missing Places key or empty targeting instead of failing", async () => {
    stubLedger();
    const noKey = await processOutreachSweep(baseDeps({ placesApiKey: "" }));
    expect(noKey.notes).toEqual([
      { businessId: BIZ, note: "no Places API key configured" }
    ]);

    stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ search_terms: [], cities: [] })])
    });
    const noTargeting = await processOutreachSweep(baseDeps());
    expect(noTargeting.notes).toEqual([
      { businessId: BIZ, note: "no search terms or cities configured" }
    ]);
  });

  it("buys nothing when another pass already claimed today's discovery", async () => {
    // The claim is atomic, so the loser skips instead of re-buying the same
    // paid searches a concurrent pass is already running.
    stubLedger({ claimDiscoveryRun: vi.fn(async () => false) });
    const searchPlacesImpl = vi.fn(async () => []);
    const result = await processOutreachSweep(baseDeps({ searchPlacesImpl }));
    expect(searchPlacesImpl).not.toHaveBeenCalled();
    expect(result.discovered).toBe(0);
  });

  it("buys at most the Standard budget of paid queries per day", async () => {
    // 2 terms x 7 cities = a 14-slot rotation, far more than one day's budget.
    stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [
        settings({
          search_terms: ["hvac", "plumber"],
          cities: ["A", "B", "C", "D", "E", "F", "G"]
        })
      ])
    });
    const searchPlacesImpl = vi.fn(async () => []);
    await processOutreachSweep(baseDeps({ searchPlacesImpl }));
    expect(searchPlacesImpl).toHaveBeenCalledTimes(6);
  });

  it("doubles the daily query budget for an Enterprise tenant", async () => {
    stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [
        settings({
          search_terms: ["hvac", "plumber"],
          cities: ["A", "B", "C", "D", "E", "F", "G"]
        })
      ])
    });
    const searchPlacesImpl = vi.fn(async () => []);
    await processOutreachSweep(
      baseDeps({
        searchPlacesImpl,
        getBusinessImpl: vi.fn(async () => ({
          id: BIZ,
          name: "New Coworker",
          timezone: "America/Phoenix",
          website_url: "https://www.newcoworker.com",
          tier: "enterprise"
        }))
      })
    );
    expect(searchPlacesImpl).toHaveBeenCalledTimes(12);
  });

  it("reads the Places key from the environment when none is injected", async () => {
    stubLedger();
    const previous = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    const result = await processOutreachSweep(baseDeps({ placesApiKey: undefined }));
    expect(result.notes).toEqual([{ businessId: BIZ, note: "no Places API key configured" }]);
    process.env.GOOGLE_PLACES_API_KEY = previous;
  });
});

describe("phase 2: drafting", () => {
  const discovered = () => [prospect({ status: "discovered", email: null, pitch_body: null })];

  function draftLedger(over: Record<string, unknown> = {}) {
    return stubLedger({
      listProspectsToProbe: vi.fn(async () => discovered()),
      ...over
    });
  }

  it("probes, claims the address, and stores a pitch carrying the compliance footer", async () => {
    const ledger = draftLedger();
    const result = await processOutreachSweep(baseDeps());
    expect(result.drafted).toBe(1);
    const patches = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls;
    // The address claim comes first, then the drafted patch.
    expect(patches[0][2]).toMatchObject({ email: "info@acmehvac.com" });
    const draft = patches[1][2];
    expect(draft.status).toBe("drafted");
    expect(draft.pitch_subject).toContain("Acme HVAC");
    expect(draft.pitch_body).toContain("/api/outreach/unsubscribe?");
    expect(draft.pitch_body).toContain("1 Example Plaza, Phoenix AZ");
  });

  it("stores the editable middle beside the assembled body", async () => {
    // The two must agree, because the owner edits the first and the prospect
    // reads the second. Storing only the body is what would force an edit box
    // to contain the compliance footer.
    const ledger = draftLedger();
    await processOutreachSweep(baseDeps());
    const draft = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls[1][2];
    expect(draft.pitch_paragraphs).toContain("Hi Acme HVAC,");
    expect(draft.pitch_paragraphs).not.toContain("unsubscribe");
    expect(draft.pitch_body).toContain(draft.pitch_paragraphs);
  });

  it("falls back to the business profile address when none was typed in", async () => {
    // The Enterprise waiver removed the typed field, not the footer line: an
    // address already on the business profile is the next best source.
    const ledger = draftLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ postal_address: null })])
    });
    const result = await processOutreachSweep(
      baseDeps({
        getBusinessImpl: vi.fn(async () => ({
          id: BIZ,
          name: "New Coworker",
          timezone: "America/Phoenix",
          website_url: "https://www.newcoworker.com",
          address: "9 Profile Street, Phoenix AZ",
          tier: "enterprise"
        }))
      })
    );
    expect(result.drafted).toBe(1);
    const body = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls[1][2]
      .pitch_body as string;
    expect(body).toContain("9 Profile Street, Phoenix AZ");
  });

  it("drafts for an exempt tier with no address anywhere, and prints no blank line", async () => {
    const ledger = draftLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ postal_address: null })])
    });
    const result = await processOutreachSweep(
      baseDeps({
        getBusinessImpl: vi.fn(async () => ({
          id: BIZ,
          name: "New Coworker",
          timezone: "America/Phoenix",
          website_url: "https://www.newcoworker.com",
          address: "   ",
          tier: "enterprise"
        }))
      })
    );
    expect(result.drafted).toBe(1);
    expect(result.notes).toEqual([]);
    const body = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls[1][2]
      .pitch_body as string;
    // The unsubscribe link is never waived, and the mail ends on it rather
    // than on a blank line where an address should have been.
    expect(body).toContain("/api/outreach/unsubscribe?");
    expect(body.trimEnd().split("\n").pop()).toContain("/api/outreach/unsubscribe?");
  });

  it("still refuses a tier that must type an address and has none", async () => {
    // The waiver is per tier, so Standard keeps the hard stop even when the
    // business profile has no address either.
    stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ postal_address: null })])
    });
    const result = await processOutreachSweep(
      baseDeps({
        getBusinessImpl: vi.fn(async () => ({
          id: BIZ,
          name: "New Coworker",
          timezone: "America/Phoenix",
          website_url: null,
          address: null,
          tier: "standard"
        }))
      })
    );
    expect(result.notes).toEqual([{ businessId: BIZ, note: "no postal address configured" }]);
  });

  it("retires an unreachable site, an address-less one, and one with nothing to say", async () => {
    for (const [probeResult, expected] of [
      [
        { findings: [], email: null, reachable: false as const, failure: "site unreadable" },
        "site unreadable"
      ],
      // Unreachable with no reason given still gets an honest ledger detail.
      [{ findings: [], email: null, reachable: false as const }, "site unreadable"],
      [
        { findings: [{ code: "no_online_booking", detail: "d" }], email: null, reachable: true as const },
        "no published contact address"
      ],
      [
        { findings: [], email: "info@acmehvac.com", reachable: true as const },
        "nothing checkable to say about their site"
      ]
    ] as const) {
      const ledger = draftLedger();
      const result = await processOutreachSweep(
        baseDeps({ probeSiteImpl: vi.fn(async () => probeResult) })
      );
      expect(result.skipped).toBe(1);
      expect(result.drafted).toBe(0);
      expect(
        (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls[0][2]
      ).toMatchObject({ status: "skipped", status_detail: expected });
    }
  });

  it("retires a prospect whose address another prospect already owns", async () => {
    // The partial unique index refuses the claim: a duplicate to retire, not
    // an error to crash on.
    const ledger = draftLedger({
      patchProspect: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true)
    });
    const result = await processOutreachSweep(baseDeps());
    expect(result.skipped).toBe(1);
    expect(
      (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls[1][2]
    ).toMatchObject({ status: "skipped", status_detail: "another prospect already uses this address" });
  });

  it("falls back to the domain when the ledger has no website URL", async () => {
    const probeSiteImpl = vi.fn(async () => ({
      findings: [{ code: "no_online_booking", detail: "d" }],
      email: "info@acmehvac.com",
      reachable: true as const
    }));
    draftLedger({
      listProspectsToProbe: vi.fn(async () => [
        prospect({ status: "discovered", website: null, email: null })
      ])
    });
    await processOutreachSweep(baseDeps({ probeSiteImpl }));
    expect(probeSiteImpl).toHaveBeenCalledWith("https://acmehvac.com", "acmehvac.com");
  });

  it("polishes only the middle paragraphs, never the footer", async () => {
    const polishImpl = vi.fn(async () => ["Hi Acme HVAC,", "Polished middle."]);
    const ledger = draftLedger();
    await processOutreachSweep(baseDeps({ polishImpl }));
    const polishInput = polishImpl.mock.calls[0] as unknown as [string, string[]];
    expect(polishInput[1].join("\n")).not.toContain("unsubscribe");
    const body = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls[1][2]
      .pitch_body as string;
    expect(body).toContain("Polished middle.");
    expect(body).toContain("/api/outreach/unsubscribe?");
  });

  it("uses the configured app URL, falling back to the environment", async () => {
    const ledger = draftLedger();
    const previous = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    await processOutreachSweep(baseDeps({ appUrl: undefined }));
    const body = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls[1][2]
      .pitch_body as string;
    expect(body).toContain("http://localhost:3000/api/outreach/unsubscribe?");
    process.env.NEXT_PUBLIC_APP_URL = previous;
  });
});

describe("phase 3: sending", () => {
  function sendLedger(over: Record<string, unknown> = {}) {
    return stubLedger({
      listProspectsByStatus: vi.fn(async (_b: string, statuses: string[]) =>
        statuses.includes("drafted") ? [prospect()] : []
      ),
      ...over
    });
  }

  it("claims the prospect BEFORE the mail leaves, then hands off to the tenant's flow", async () => {
    const ledger = sendLedger();
    const deps = baseDeps();
    const result = await processOutreachSweep(deps);
    expect(result.sent).toBe(1);
    expect(ledger.transitionProspect).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      "drafted",
      { status: "sent", sent_at: MONDAY_MORNING.toISOString() },
      expect.anything()
    );
    const send = (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl;
    expect(send).toHaveBeenCalledWith(BIZ, {
      toEmail: "info@acmehvac.com",
      subject: prospect().pitch_subject,
      bodyText: prospect().pitch_body
    });
    const flow = (deps as unknown as { processFlowEventImpl: ReturnType<typeof vi.fn> })
      .processFlowEventImpl;
    expect(flow).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        source: PROSPECT_OUTREACH_SOURCE,
        eventId: `outreach:${prospect().id}`
      }),
      expect.anything(),
      // Platform hand-off after our own send: internal origin, exempt from
      // the webhook tier gate.
      { origin: "internal" }
    );
  });

  it("abandons a claimed send when the prospect opted out in the meantime", async () => {
    // The claim is guarded on status, so an opt-out landing BEFORE it loses
    // cleanly. One landing just after it is caught here, or we would mail
    // somebody who has already asked to stop.
    // The undo restores the state the abort reason implies. Clearing sent_at
    // alone would leave a row reading `sent` with no send behind it: invisible
    // to the queue, unsendable, and counted as outreach by the funnel.
    for (const [current, expectedPatch] of [
      [prospect({ status: "unsubscribed" }), { sent_at: null, status: "unsubscribed" }],
      [prospect({ replied_at: "2026-07-27T15:59:00Z" }), { sent_at: null, status: "replied" }]
    ] as const) {
      const ledger = sendLedger({ getProspect: vi.fn(async () => current) });
      const deps = baseDeps();
      const result = await processOutreachSweep(deps);
      expect(result.sent).toBe(0);
      expect(
        (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
      ).not.toHaveBeenCalled();
      expect(ledger.patchProspect).toHaveBeenCalledWith(
        BIZ,
        prospect().id,
        expectedPatch,
        expect.anything()
      );
    }
  });

  it("undoes its claim even when the row vanished under it", async () => {
    const ledger = sendLedger({ getProspect: vi.fn(async () => null) });
    const deps = baseDeps();
    const result = await processOutreachSweep(deps);
    expect(result.sent).toBe(0);
    expect(
      (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
    ).not.toHaveBeenCalled();
    // The write hits nothing when the row is genuinely gone. It is issued
    // anyway so that every abort path undoes its own claim by construction.
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      { sent_at: null, status: "drafted" },
      expect.anything()
    );
  });

  it("does not send twice when another pass already claimed the prospect", async () => {
    sendLedger({ transitionProspect: vi.fn(async () => false) });
    const deps = baseDeps();
    const result = await processOutreachSweep(deps);
    expect(result.sent).toBe(0);
    expect(
      (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
    ).not.toHaveBeenCalled();
  });

  it("respects the weekday window and the daily cap", async () => {
    sendLedger();
    const afternoon = await processOutreachSweep(baseDeps({ now: () => MONDAY_AFTERNOON }));
    expect(afternoon.sent).toBe(0);
    expect(afternoon.notes).toContainEqual({
      businessId: BIZ,
      note: "outside the send window"
    });

    sendLedger({ countProspectsSentSince: vi.fn(async () => 12) });
    const capped = await processOutreachSweep(baseDeps());
    expect(capped.sent).toBe(0);
    expect(capped.notes).toContainEqual({ businessId: BIZ, note: "daily cap reached" });
  });

  it("only asks for as many drafts as the cap still allows", async () => {
    const ledger = sendLedger({ countProspectsSentSince: vi.fn(async () => 10) });
    await processOutreachSweep(baseDeps());
    expect(ledger.listProspectsByStatus).toHaveBeenCalledWith(
      BIZ,
      ["drafted"],
      2,
      expect.anything()
    );
  });

  it("counts today's follow-ups against the same cap as first pitches", async () => {
    // 8 first pitches plus 4 follow-ups already used the 12-a-day allowance, so
    // nothing more goes out even though neither count alone reaches the cap.
    const ledger = sendLedger({
      countProspectsSentSince: vi.fn(async () => 8),
      countProspectsNudgedSince: vi.fn(async () => 4)
    });
    const result = await processOutreachSweep(baseDeps());
    expect(result.sent).toBe(0);
    expect(result.notes).toContainEqual({ businessId: BIZ, note: "daily cap reached" });
    expect(ledger.listProspectsByStatus).not.toHaveBeenCalledWith(
      BIZ,
      ["drafted"],
      expect.anything(),
      expect.anything()
    );
  });

  it("never sends in manual mode: the drafts wait for the owner", async () => {
    sendLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ mode: "manual" })])
    });
    const deps = baseDeps();
    const result = await processOutreachSweep(deps);
    expect(result.sent).toBe(0);
    expect(
      (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
    ).not.toHaveBeenCalled();
  });

  it("records a refused send as failed and clears the premature sent stamp", async () => {
    const ledger = sendLedger();
    const result = await processOutreachSweep(
      baseDeps({
        sendEmailImpl: vi.fn(async () => ({ ok: false as const, detail: "email_not_connected" }))
      })
    );
    expect(result.sent).toBe(0);
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      { status: "failed", status_detail: "email_not_connected", sent_at: null },
      expect.anything()
    );
  });

  it("records a thrown send as failed rather than losing the prospect in 'sent'", async () => {
    const ledger = sendLedger();
    const result = await processOutreachSweep(
      baseDeps({
        sendEmailImpl: vi.fn(async () => {
          throw new Error("gmail 500");
        })
      })
    );
    expect(result.sent).toBe(0);
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      expect.objectContaining({ status: "failed", status_detail: "gmail 500", sent_at: null }),
      expect.anything()
    );
  });

  it("says so when no flow MATCHED, not merely when none exists", async () => {
    // A tenant can have other webhook flows enabled while the prospect
    // follow-through one is missing or switched off. Counting enabled flows
    // would call that fine and file nothing, silently.
    sendLedger();
    const result = await processOutreachSweep(
      baseDeps({
        processFlowEventImpl: vi.fn(async () => ({
          enqueued: 0,
          flowsEvaluated: 3,
          flowsMatched: 0
        }))
      })
    );
    expect(result.sent).toBe(1);
    expect(result.notes).toContainEqual({
      businessId: BIZ,
      note: "no flow matched, so the prospect was emailed but not filed"
    });
  });

  it("treats a matched-but-not-enqueued event as the redelivery it is", async () => {
    sendLedger();
    const result = await processOutreachSweep(
      baseDeps({
        processFlowEventImpl: vi.fn(async () => ({
          enqueued: 0,
          flowsEvaluated: 1,
          flowsMatched: 1
        }))
      })
    );
    expect(result.sent).toBe(1);
    expect(result.notes).toEqual([]);
  });

  it("registers the thread so the coworker can answer the prospect's reply", async () => {
    sendLedger();
    const deps = baseDeps();
    await processOutreachSweep(deps);
    expect(
      (deps as unknown as { rememberThreadImpl: ReturnType<typeof vi.fn> }).rememberThreadImpl
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        provider: "google",
        threadId: "thread-1",
        correspondentEmail: "info@acmehvac.com",
        sentMessageRef: "msg-1"
      }),
      expect.anything()
    );
  });

  it("sends fine when the provider reports no thread id (Microsoft)", async () => {
    sendLedger();
    const deps = baseDeps({
      sendEmailImpl: vi.fn(async () => ({
        ok: true as const,
        provider: "microsoft" as const,
        messageId: "msg-1",
        threadId: null
      }))
    });
    const result = await processOutreachSweep(deps);
    expect(result.sent).toBe(1);
    // Nothing to register, so no autonomous follow-ups for that tenant yet.
    expect(
      (deps as unknown as { rememberThreadImpl: ReturnType<typeof vi.fn> }).rememberThreadImpl
    ).not.toHaveBeenCalled();
  });

  it("sends from the mailbox the owner picked for outreach", async () => {
    sendLedger({
      listActiveOutreachSettings: vi.fn(async () => [
        settings({ from_connection_id: "conn-row" })
      ])
    });
    const deps = baseDeps();
    const result = await processOutreachSweep(deps);
    expect(result.sent).toBe(1);
    const viaConnection = (
      deps as unknown as { sendFromConnectionImpl: ReturnType<typeof vi.fn> }
    ).sendFromConnectionImpl;
    expect(viaConnection).toHaveBeenCalledWith(
      BIZ,
      { provider: "google", providerConfigKey: "google-mail", connectionId: "nango-conn" },
      expect.objectContaining({ toEmail: "info@acmehvac.com" })
    );
    // The default-connection path is NOT used when a choice was stored.
    expect(
      (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
    ).not.toHaveBeenCalled();
  });

  it("fails rather than silently sending from the wrong address when that mailbox is gone", async () => {
    for (const getMailboxConnectionImpl of [
      vi.fn(async () => null),
      vi.fn(async () => ({
        id: "conn-row",
        connection_id: "nango-conn",
        provider_config_key: "google-calendar"
      }))
    ]) {
      const ledger = sendLedger({
        listActiveOutreachSettings: vi.fn(async () => [
          settings({ from_connection_id: "conn-row" })
        ])
      });
      const result = await processOutreachSweep(baseDeps({ getMailboxConnectionImpl }));
      expect(result.sent).toBe(0);
      expect(ledger.patchProspect).toHaveBeenCalledWith(
        BIZ,
        prospect().id,
        expect.objectContaining({ status: "failed", status_detail: "email_not_connected" }),
        expect.anything()
      );
    }
  });

  it("keeps the send when the flow hand-off itself fails, however it failed", async () => {
    for (const thrown of [new Error("queue down"), "queue down"]) {
      sendLedger();
      const result = await processOutreachSweep(
        baseDeps({
          processFlowEventImpl: vi.fn(async () => {
            throw thrown;
          })
        })
      );
      // The mail already went; the hand-off is bookkeeping.
      expect(result.sent).toBe(1);
      expect(result.notes).toContainEqual({
        businessId: BIZ,
        note: "flow hand-off failed: queue down"
      });
    }
  });

  it("logs the send onto email_log so it shows on the owner's Emails page", async () => {
    sendLedger();
    const deps = baseDeps();
    await processOutreachSweep(deps);
    expect(
      (deps as unknown as { recordEmailLogImpl: ReturnType<typeof vi.fn> }).recordEmailLogImpl
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        businessId: BIZ,
        to: "info@acmehvac.com",
        // The default mock reports no sending address (a legacy connection
        // with bare metadata), so the log falls back to who signed the mail.
        from: "Brian",
        providerMessageId: "msg-1"
      })
    );
  });

  it("logs the real mailbox address when the send reports one", async () => {
    sendLedger();
    const deps = baseDeps({
      sendEmailImpl: vi.fn(async () => ({
        ok: true as const,
        provider: "google" as const,
        messageId: "msg-1",
        threadId: "thread-1",
        fromEmail: "brian@acmehq.com"
      }))
    });
    await processOutreachSweep(deps);
    // The address beats the signature: it is what replies actually go to.
    expect(
      (deps as unknown as { recordEmailLogImpl: ReturnType<typeof vi.fn> }).recordEmailLogImpl
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: "brian@acmehq.com" })
    );
  });

  it("logs the business name when no sender name is configured", async () => {
    sendLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ sender_name: null })])
    });
    const deps = baseDeps();
    await processOutreachSweep(deps);
    expect(
      (deps as unknown as { recordEmailLogImpl: ReturnType<typeof vi.fn> }).recordEmailLogImpl
    ).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ from: "New Coworker" }));
  });

  it("refuses to send a draft missing its address or pitch text", async () => {
    for (const broken of [
      prospect({ email: null }),
      prospect({ pitch_subject: "   " }),
      prospect({ pitch_body: null })
    ]) {
      const ledger = sendLedger({
        listProspectsByStatus: vi.fn(async (_b: string, statuses: string[]) =>
          statuses.includes("drafted") ? [broken] : []
        )
      });
      const deps = baseDeps();
      const result = await processOutreachSweep(deps);
      expect(result.sent).toBe(0);
      // A blank cold email is worse than none, and a silent fallback would
      // hide whatever produced the bad row.
      expect(ledger.patchProspect).toHaveBeenCalledWith(
        BIZ,
        broken.id,
        {
          status: "failed",
          status_detail: "draft is missing its address or pitch text",
          sent_at: null
        },
        expect.anything()
      );
      expect(
        (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
      ).not.toHaveBeenCalled();
    }
  });

  it("records a non-Error throw from the provider library", async () => {
    const ledger = sendLedger();
    const result = await processOutreachSweep(
      baseDeps({
        sendEmailImpl: vi.fn(async () => {
          // Some provider clients reject with a string, not an Error.
          throw "smtp said no";
        })
      })
    );
    expect(result.sent).toBe(0);
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      expect.objectContaining({ status: "failed", status_detail: "smtp said no" }),
      expect.anything()
    );
  });

  it("passes a phone-less prospect to the flow as the extractor's 'none' sentinel", async () => {
    // Null AND blank: a blank is the trap, since it is neither null nor 'none'
    // and would sail through the flow's gate into a phone-keyed CRM.
    for (const phone of [null, "   "]) {
      sendLedger({
        listProspectsByStatus: vi.fn(async (_b: string, statuses: string[]) =>
          statuses.includes("drafted") ? [prospect({ phone })] : []
        )
      });
      const deps = baseDeps();
      await processOutreachSweep(deps);
      const flow = (deps as unknown as { processFlowEventImpl: ReturnType<typeof vi.fn> })
        .processFlowEventImpl;
      const payload = flow.mock.calls[0][1] as { data: Record<string, string> };
      expect(payload.data.prospect_phone).toBe("none");
    }
  });
});

describe("phase 4: the single nudge", () => {
  function nudgeLedger(over: Record<string, unknown> = {}) {
    return stubLedger({
      listProspectsDueForNudge: vi.fn(async () => [
        prospect({ status: "sent", sent_at: "2026-07-20T16:00:00Z" })
      ]),
      ...over
    });
  }

  it("follows up once, on the original subject, with the footer intact", async () => {
    const ledger = nudgeLedger();
    const deps = baseDeps();
    const result = await processOutreachSweep(deps);
    expect(result.nudged).toBe(1);
    // Claimed through the nudge-specific guard, not the status transition: a
    // nudge leaves the status alone, so "nudged_at is still null" is the only
    // thing that stops two overlapping passes both sending it.
    expect(ledger.claimProspectNudge).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      MONDAY_MORNING.toISOString(),
      expect.anything()
    );
    const send = (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl;
    const args = send.mock.calls[0][1] as { subject: string; bodyText: string };
    expect(args.subject).toBe(prospect().pitch_subject);
    expect(args.bodyText).toContain("/api/outreach/unsubscribe?");
    expect(args.bodyText).toContain("1 Example Plaza, Phoenix AZ");
    expect(args.bodyText).toContain("I wrote last week");
  });

  it("asks only for prospects inside the patience window", async () => {
    const ledger = nudgeLedger();
    await processOutreachSweep(baseDeps());
    expect(ledger.listProspectsDueForNudge).toHaveBeenCalledWith(
      BIZ,
      "2026-07-06T16:00:00.000Z",
      "2026-07-22T16:00:00.000Z",
      5,
      expect.anything()
    );
  });

  it("spends only what the cap has left, and stops when first pitches used it", async () => {
    // 10 of 12 already sent today leaves 2, so the follow-up batch shrinks to
    // 2 rather than its usual 5.
    const ledger = nudgeLedger({ countProspectsSentSince: vi.fn(async () => 10) });
    await processOutreachSweep(baseDeps());
    expect(ledger.listProspectsDueForNudge).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      2,
      expect.anything()
    );

    // And when the first pitches in THIS pass consume the last of the cap,
    // nothing is left for follow-ups at all.
    const exhausted = nudgeLedger({
      countProspectsSentSince: vi.fn(async () => 11),
      listProspectsByStatus: vi.fn(async (_b: string, statuses: string[]) =>
        statuses.includes("drafted") ? [prospect()] : []
      )
    });
    const result = await processOutreachSweep(baseDeps());
    expect(result.sent).toBe(1);
    expect(result.nudged).toBe(0);
    expect(exhausted.listProspectsDueForNudge).not.toHaveBeenCalled();
  });

  it("a failed follow-up keeps the original send and frees the nudge to retry", async () => {
    // The first pitch really did go out. Marking the row failed and clearing
    // sent_at would erase a real send, drop the day's count, and burn the one
    // allowed nudge on an email nobody received.
    for (const sendEmailImpl of [
      vi.fn(async () => ({ ok: false as const, detail: "email_not_connected" })),
      vi.fn(async () => {
        throw new Error("gmail 500");
      })
    ]) {
      const ledger = nudgeLedger();
      const result = await processOutreachSweep(baseDeps({ sendEmailImpl }));
      expect(result.nudged).toBe(0);
      const patch = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(patch).toMatchObject({ nudged_at: null });
      expect(patch.status).toBeUndefined();
      expect(patch).not.toHaveProperty("sent_at");
    }
  });

  it("nudges nobody outside the send window", async () => {
    const ledger = nudgeLedger();
    await processOutreachSweep(baseDeps({ now: () => MONDAY_AFTERNOON }));
    expect(ledger.listProspectsDueForNudge).not.toHaveBeenCalled();
  });

  it("greets a nameless prospect neutrally and keeps a missing subject sane", async () => {
    nudgeLedger({
      listProspectsDueForNudge: vi.fn(async () => [
        prospect({ status: "sent", business_name: "  ", pitch_subject: null })
      ])
    });
    const deps = baseDeps();
    await processOutreachSweep(deps);
    const send = (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl;
    const args = send.mock.calls[0][1] as { subject: string; bodyText: string };
    expect(args.subject).toBe("Following up");
    expect(args.bodyText).toContain("Hi there,");
  });

  it("counts nothing when the nudge claim is lost to another pass", async () => {
    nudgeLedger({ claimProspectNudge: vi.fn(async () => false) });
    const deps = baseDeps();
    const result = await processOutreachSweep(deps);
    expect(result.nudged).toBe(0);
    expect(
      (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
    ).not.toHaveBeenCalled();
  });

  it("abandons a claimed nudge when the prospect replied, opted out, or vanished", async () => {
    for (const current of [prospect({ status: "unsubscribed" }), null]) {
      const ledger = nudgeLedger({ getProspect: vi.fn(async () => current) });
      const deps = baseDeps();
      const result = await processOutreachSweep(deps);
      expect(result.nudged).toBe(0);
      expect(
        (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
      ).not.toHaveBeenCalled();
      // The nudge stamp is released, so the one follow-up is not burned on
      // an email that never went out.
      expect(ledger.patchProspect).toHaveBeenCalledWith(
        BIZ,
        prospect().id,
        { nudged_at: null },
        expect.anything()
      );
    }
  });

  it("skips a nudge-due row with no address rather than burning its one follow-up", async () => {
    const ledger = nudgeLedger({
      listProspectsDueForNudge: vi.fn(async () => [prospect({ status: "sent", email: null })])
    });
    const deps = baseDeps();
    const result = await processOutreachSweep(deps);
    expect(result.nudged).toBe(0);
    expect(ledger.transitionProspect).not.toHaveBeenCalled();
    expect(
      (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
    ).not.toHaveBeenCalled();
  });
});

describe("sendProspectNow (the owner pressed Send in manual mode)", () => {
  function nowLedger(over: Record<string, unknown> = {}) {
    return stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      getProspect: vi.fn(async () => prospect()),
      ...over
    });
  }

  it("sends through the same path the sweep uses, including the flow hand-off", async () => {
    const ledger = nowLedger();
    const deps = baseDeps();
    const result = await sendProspectNow(BIZ, prospect().id, deps);
    expect(result).toEqual({ ok: true, notes: [] });
    // Same guarded claim as the automatic path: one prospect, one email.
    expect(ledger.transitionProspect).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      "drafted",
      { status: "sent", sent_at: MONDAY_MORNING.toISOString() },
      expect.anything()
    );
    expect(
      (deps as unknown as { processFlowEventImpl: ReturnType<typeof vi.fn> }).processFlowEventImpl
    ).toHaveBeenCalled();
  });

  it("ignores the send window, because the owner chose this moment", async () => {
    nowLedger();
    const result = await sendProspectNow(
      BIZ,
      prospect().id,
      baseDeps({ now: () => MONDAY_AFTERNOON })
    );
    expect(result.ok).toBe(true);
  });

  it("still honors the daily cap, counting today's follow-ups too", async () => {
    nowLedger({
      countProspectsSentSince: vi.fn(async () => 8),
      countProspectsNudgedSince: vi.fn(async () => 4)
    });
    const deps = baseDeps();
    expect(await sendProspectNow(BIZ, prospect().id, deps)).toEqual({
      ok: false,
      reason: "cap_reached"
    });
    expect(
      (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
    ).not.toHaveBeenCalled();
  });

  it("refuses when the business is unconfigured, or its setup is incomplete", async () => {
    nowLedger({ getOutreachSettings: vi.fn(async () => null) });
    expect(await sendProspectNow(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_configured"
    });

    nowLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual", value_prop: null }))
    });
    expect(await sendProspectNow(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_configured",
      detail: "no value proposition configured"
    });
  });

  it("refuses with tier_blocked on Starter", async () => {
    nowLedger();
    expect(
      await sendProspectNow(
        BIZ,
        prospect().id,
        baseDeps({
          getBusinessImpl: vi.fn(async () => ({
            id: BIZ,
            name: "Starter Co",
            timezone: "America/Phoenix",
            website_url: null,
            tier: "starter"
          }))
        })
      )
    ).toEqual({
      ok: false,
      reason: "tier_blocked",
      detail: "prospecting requires the Standard plan"
    });
  });

  it("refuses a prospect that is gone, already handled, or missing its text", async () => {
    nowLedger({ getProspect: vi.fn(async () => null) });
    expect(await sendProspectNow(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_found"
    });

    nowLedger({ getProspect: vi.fn(async () => prospect({ status: "sent" })) });
    expect(await sendProspectNow(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_drafted"
    });

    const ledger = nowLedger({ getProspect: vi.fn(async () => prospect({ pitch_body: null })) });
    expect(await sendProspectNow(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_drafted",
      detail: "the draft has no address or pitch text"
    });
    // Recorded, not just reported: otherwise the broken draft stays in the
    // queue and the owner can press Send on it forever.
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      {
        status: "failed",
        status_detail: "draft is missing its address or pitch text",
        sent_at: null
      },
      expect.anything()
    );
  });

  it("reports a send that failed, and a send with no flow to file it", async () => {
    nowLedger();
    expect(
      await sendProspectNow(
        BIZ,
        prospect().id,
        baseDeps({
          sendEmailImpl: vi.fn(async () => ({ ok: false as const, detail: "email_not_connected" }))
        })
      )
    ).toEqual({ ok: false, reason: "send_failed" });

    nowLedger();
    const noFlow = await sendProspectNow(
      BIZ,
      prospect().id,
      baseDeps({
        processFlowEventImpl: vi.fn(async () => ({
          enqueued: 0,
          flowsEvaluated: 2,
          flowsMatched: 0
        }))
      })
    );
    // The mail went; the owner is told the filing did not happen.
    expect(noFlow).toEqual({
      ok: true,
      notes: ["no flow matched, so the prospect was emailed but not filed"]
    });
  });

  it("does not send when another pass already claimed the prospect", async () => {
    nowLedger({ transitionProspect: vi.fn(async () => false) });
    expect(await sendProspectNow(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "send_failed"
    });
  });
});

describe("editProspectDraft and regenerateProspectDraft (the owner reworked a draft)", () => {
  function draftLedger(over: Record<string, unknown> = {}) {
    return stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      getProspect: vi.fn(async () => prospect()),
      ...over
    });
  }

  it("keeps the owner's words and re-assembles the footer around them", async () => {
    // The point of the whole split: an edit box that cannot delete the
    // unsubscribe link or the postal address, because it never held them.
    const ledger = draftLedger();
    const result = await editProspectDraft(
      BIZ,
      prospect().id,
      { subject: "  A subject the owner wrote  ", paragraphs: "Hi there,\n\nMy own pitch." },
      baseDeps()
    );
    expect(result.ok).toBe(true);
    const patch = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(patch.pitch_subject).toBe("A subject the owner wrote");
    expect(patch.pitch_paragraphs).toBe("Hi there,\n\nMy own pitch.");
    expect(patch.pitch_body).toContain("My own pitch.");
    expect(patch.pitch_body).toContain("/api/outreach/unsubscribe?");
    expect(patch.pitch_body).toContain("1 Example Plaza, Phoenix AZ");
    // Guarded on it still being a draft, exactly like Send and Skip.
    expect((ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe("drafted");
  });

  it("normalizes ragged spacing into paragraphs", async () => {
    const ledger = draftLedger();
    await editProspectDraft(
      BIZ,
      prospect().id,
      { subject: "s", paragraphs: "One.\n\n\n   \n\nTwo.   \n\n" },
      baseDeps()
    );
    const patch = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(patch.pitch_paragraphs).toBe("One.\n\nTwo.");
  });

  it("refuses an empty draft or one longer than a cold email should be", async () => {
    const ledger = draftLedger();
    for (const edit of [
      { subject: "  ", paragraphs: "text" },
      { subject: "s", paragraphs: "   " }
    ]) {
      expect(await editProspectDraft(BIZ, prospect().id, edit, baseDeps())).toEqual({
        ok: false,
        reason: "empty_text"
      });
    }
    expect(
      await editProspectDraft(
        BIZ,
        prospect().id,
        { subject: "s", paragraphs: "x".repeat(MAX_EDITED_BODY_CHARS + 1) },
        baseDeps()
      )
    ).toEqual({ ok: false, reason: "too_long" });
    expect(
      await editProspectDraft(
        BIZ,
        prospect().id,
        { subject: "s".repeat(MAX_EDITED_SUBJECT_CHARS + 1), paragraphs: "text" },
        baseDeps()
      )
    ).toEqual({ ok: false, reason: "too_long" });
    // Refused before any write: a bad edit must not touch the ledger.
    expect(ledger.transitionProspect).not.toHaveBeenCalled();
  });

  it("refuses a prospect that is gone, no longer a draft, or claimed mid-edit", async () => {
    draftLedger({ getProspect: vi.fn(async () => null) });
    expect(
      await editProspectDraft(BIZ, prospect().id, { subject: "s", paragraphs: "p" }, baseDeps())
    ).toEqual({ ok: false, reason: "not_found" });

    draftLedger({ getProspect: vi.fn(async () => prospect({ status: "sent" })) });
    expect(
      await editProspectDraft(BIZ, prospect().id, { subject: "s", paragraphs: "p" }, baseDeps())
    ).toEqual({ ok: false, reason: "not_drafted" });

    // The queue can be minutes stale: the sweep may have sent this prospect
    // between the read and the write, and the guarded update is what catches
    // it. Rewriting the stored copy of a mail already in someone's inbox
    // would make the ledger disagree with reality.
    draftLedger({ transitionProspect: vi.fn(async () => false) });
    expect(
      await editProspectDraft(BIZ, prospect().id, { subject: "s", paragraphs: "p" }, baseDeps())
    ).toEqual({ ok: false, reason: "not_drafted" });
  });

  it("refuses an unconfigured or downgraded tenant, and says which", async () => {
    draftLedger({ getOutreachSettings: vi.fn(async () => null) });
    expect(await regenerateProspectDraft(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_configured"
    });

    draftLedger();
    expect(
      await regenerateProspectDraft(
        BIZ,
        prospect().id,
        baseDeps({ getBusinessImpl: vi.fn(async () => null) })
      )
    ).toEqual({ ok: false, reason: "not_configured", detail: "business row is gone" });

    draftLedger();
    expect(
      await regenerateProspectDraft(
        BIZ,
        prospect().id,
        baseDeps({
          getBusinessImpl: vi.fn(async () => ({
            id: BIZ,
            name: "Starter Co",
            timezone: "America/Phoenix",
            website_url: null,
            tier: "starter"
          }))
        })
      )
    ).toEqual({
      ok: false,
      reason: "tier_blocked",
      detail: "prospecting requires the Standard plan"
    });
  });

  it("writes the pitch again from the stored findings, without re-probing", async () => {
    const probeSiteImpl = vi.fn(async () => {
      throw new Error("regenerate must not fetch the prospect's site");
    });
    const polishImpl = vi.fn(async () => ["Hi Acme HVAC,", "A second attempt."]);
    const ledger = draftLedger();
    const result = await regenerateProspectDraft(
      BIZ,
      prospect().id,
      baseDeps({ polishImpl, probeSiteImpl })
    );
    expect(result.ok).toBe(true);
    expect(probeSiteImpl).not.toHaveBeenCalled();
    const patch = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(patch.pitch_paragraphs).toBe("Hi Acme HVAC,\n\nA second attempt.");
    expect(patch.pitch_body).toContain("A second attempt.");
    expect(patch.pitch_body).toContain("/api/outreach/unsubscribe?");
    // The polish pass never sees the footer, on this path either.
    expect((polishImpl.mock.calls[0] as unknown as [string, string[]])[1].join("\n")).not.toContain(
      "unsubscribe"
    );
  });

  it("refuses to rewrite a draft with nothing checkable left to say", async () => {
    // The row was pitchable when it was drafted, but the finding vocabulary
    // can change under a stored row, and a vague compliment is spam whatever
    // the footer says.
    draftLedger({ getProspect: vi.fn(async () => prospect({ findings: [] })) });
    expect(await regenerateProspectDraft(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_pitchable"
    });

    draftLedger({
      getProspect: vi.fn(async () => prospect({ findings: null as never }))
    });
    expect(await regenerateProspectDraft(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_pitchable"
    });
  });

  it("cannot be lost to a claim race either", async () => {
    draftLedger({ transitionProspect: vi.fn(async () => false) });
    expect(await regenerateProspectDraft(BIZ, prospect().id, baseDeps())).toEqual({
      ok: false,
      reason: "not_drafted"
    });
  });
});

describe("recordOutreachEmailLog", () => {
  it("writes the outbound row", async () => {
    const insert = vi.fn(async (_row: { body_preview: string }) => ({ error: null }));
    const client = { from: vi.fn(() => ({ insert })) } as never;
    await recordOutreachEmailLog(client, {
      businessId: BIZ,
      to: "info@acmehvac.com",
      from: "Brian",
      subject: "s",
      body: "b".repeat(600),
      providerMessageId: "msg-1"
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        direction: "outbound",
        source: "owner_mailbox",
        provider_message_id: "msg-1"
      })
    );
    // Only a preview is logged, matching the flow worker's own email_log write.
    expect(insert.mock.calls[0][0].body_preview).toHaveLength(500);
  });

  it("never throws when the log write fails: the mail has already gone", async () => {
    const insert = vi.fn(async () => ({ error: { message: "log table down" } }));
    const client = { from: vi.fn(() => ({ insert })) } as never;
    await expect(
      recordOutreachEmailLog(client, {
        businessId: BIZ,
        to: "a@b.com",
        from: "Brian",
        subject: "s",
        body: "b",
        providerMessageId: null
      })
    ).resolves.toBeUndefined();
  });
});
