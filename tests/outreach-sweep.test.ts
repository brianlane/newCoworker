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
  REWRITE_BATCH_SIZE,
  sendDraftsNow,
  SEND_NOW_BATCH,
  rewriteAllProspectDrafts,
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
    booking_meeting_type_id: null,
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
    contacted_stage_at: null,
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
    // A connected mailbox is the normal case; the tests that care about its
    // absence override this with null.
    resolveEmailConnectionImpl: vi.fn(async () => ({
      provider: "google" as const,
      providerConfigKey: "google-mail",
      connectionId: "nango-conn"
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
    fireLifecycleStageImpl: vi.fn(async () => "moved" as const),
    // Nobody has booked or advanced, which is the case every phase-4 test
    // below is about. The engagement check has its own suite
    // (outreach-engagement.test.ts); the tests that care about the
    // SUPPRESSION it drives override this.
    findEngagedImpl: vi.fn(async () => ({ engaged: new Set<string>(), readFailed: false })),
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
    listProspectsContactedSince: vi.fn(async () => []),
    listProspectsToRewrite: vi.fn(async () => []),
    countProspectsToRewrite: vi.fn(async () => 0),
    countProspectsByStatus: vi.fn(async () => 0),
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
    const body = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[3]
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
    // The address claim is an unguarded patch; the draft itself is a guarded
    // transition off `discovered`, so the two land on different writers.
    const patches = (ledger.patchProspect as ReturnType<typeof vi.fn>).mock.calls;
    expect(patches[0][2]).toMatchObject({ email: "info@acmehvac.com" });
    const claim = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(claim[2]).toBe("discovered");
    const draft = claim[3];
    expect(draft.status).toBe("drafted");
    expect(draft.pitch_subject).toContain("Acme HVAC");
    expect(draft.pitch_body).toContain("/api/outreach/unsubscribe?");
    expect(draft.pitch_body).toContain("1 Example Plaza, Phoenix AZ");
  });

  it("drops the compose when the prospect was retired while it ran", async () => {
    // A pass takes seconds per prospect (a probe, then a model call), and the
    // owner can call off the whole trade while it runs. Before the guard, the
    // compose finished and moved a just-skipped prospect BACK to `drafted`, and
    // in automatic mode that draft then went out: the trade the owner stopped
    // got emailed anyway.
    const ledger = draftLedger({ transitionProspect: vi.fn(async () => false) });
    const result = await processOutreachSweep(baseDeps());
    expect(result.drafted).toBe(0);
    // Recorded rather than swallowed: a silent zero looks like a probe failure.
    expect(result.notes).toContainEqual({
      businessId: BIZ,
      note: "acmehvac.com: retired while it was being drafted"
    });
    // The claim was attempted, and nothing else was written after it lost.
    expect((ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("stores the editable middle beside the assembled body", async () => {
    // The two must agree, because the owner edits the first and the prospect
    // reads the second. Storing only the body is what would force an edit box
    // to contain the compliance footer.
    const ledger = draftLedger();
    await processOutreachSweep(baseDeps());
    const draft = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3];
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
    const body = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3]
      .pitch_body as string;
    expect(body).toContain("9 Profile Street, Phoenix AZ");
  });

  it("drafts for an exempt tier with no address anywhere, and prints no blank line", async () => {
    // Blank and absent both count as no address on the profile, the same way
    // the settings field treats them.
    for (const address of [null, "   ", undefined]) {
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
            address,
            tier: "enterprise"
          }))
        })
      );
      expect(result.drafted).toBe(1);
      expect(result.notes).toEqual([]);
      const body = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3]
        .pitch_body as string;
      // The unsubscribe link is never waived, and the mail ends on it rather
      // than on a blank line where an address should have been.
      expect(body).toContain("/api/outreach/unsubscribe?");
      expect(body.trimEnd().split("\n").pop()).toContain("/api/outreach/unsubscribe?");
    }
  });

  it("never lends the profile address to a tier that must type one", async () => {
    // The page and the sender have to agree. describeBlockers names the typed
    // field and the check constraint requires it, so a Standard tenant with a
    // profile address but a blank panel field must NOT send: a Marketing page
    // saying outreach cannot run while mail goes out is the worst outcome
    // available. This is also the downgrade case, since Enterprise to Standard
    // leaves a stale postal_address_exempt behind and the tier is re-read here.
    stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [
        settings({ postal_address: null, postal_address_exempt: true })
      ])
    });
    const result = await processOutreachSweep(
      baseDeps({
        getBusinessImpl: vi.fn(async () => ({
          id: BIZ,
          name: "New Coworker",
          timezone: "America/Phoenix",
          website_url: null,
          address: "9 Profile Street, Phoenix AZ",
          tier: "standard"
        }))
      })
    );
    expect(result.notes).toEqual([{ businessId: BIZ, note: "no postal address configured" }]);
    expect(result.drafted).toBe(0);
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
    const body = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3]
      .pitch_body as string;
    expect(body).toContain("Polished middle.");
    expect(body).toContain("/api/outreach/unsubscribe?");
  });

  it("uses the configured app URL, falling back to the environment", async () => {
    const ledger = draftLedger();
    const previous = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    await processOutreachSweep(baseDeps({ appUrl: undefined }));
    const body = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3]
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

  it("stops the pass rather than sending from the wrong address when that mailbox is gone", async () => {
    // Never sending from an address the owner did not choose is the original
    // rule and it still holds. What changed is the shape of the refusal: this
    // used to be discovered one prospect at a time, AFTER the claim, so every
    // draft was stamped `failed`, which is terminal. A disconnected mailbox is
    // a configuration problem, and it must not eat the queue on the way to
    // being noticed.
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
      const deps = baseDeps({ getMailboxConnectionImpl });
      const result = await processOutreachSweep(deps);
      expect(result.sent).toBe(0);
      expect(result.notes).toContainEqual({
        businessId: BIZ,
        note: "the mailbox chosen for outreach is no longer connected"
      });
      // Nothing claimed, nothing stamped, nothing sent: the drafts survive to
      // go out on the first pass after the mailbox is reconnected.
      expect(ledger.transitionProspect).not.toHaveBeenCalled();
      expect(ledger.patchProspect).not.toHaveBeenCalled();
      expect(
        (deps as unknown as { sendFromConnectionImpl: ReturnType<typeof vi.fn> })
          .sendFromConnectionImpl
      ).not.toHaveBeenCalled();
    }
  });

  it("still refuses mid-pass if the mailbox disappears after the pre-flight", async () => {
    // The pre-flight narrows this window, it does not close it: the owner can
    // disconnect between the check and the provider call. The send path keeps
    // its own guard so the race fails closed rather than quietly falling back
    // to the default address, which is the whole point of pinning one.
    const ledger = sendLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ from_connection_id: "conn-row" })])
    });
    const getMailboxConnectionImpl = vi
      .fn()
      // The pre-flight sees it.
      .mockResolvedValueOnce({
        id: "conn-row",
        connection_id: "nango-conn",
        provider_config_key: "google-mail"
      })
      // By the time the send looks, it is gone.
      .mockResolvedValue(null);
    const result = await processOutreachSweep(baseDeps({ getMailboxConnectionImpl }));
    expect(result.sent).toBe(0);
    // Here the claim HAS happened, so the row is released the normal way.
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      expect.objectContaining({ status: "failed", status_detail: "email_not_connected" }),
      expect.anything()
    );
  });

  it("stops the pass when no mailbox is connected at all", async () => {
    // The commoner case, and the one that used to burn a whole queue quietly:
    // an owner who switched Prospecting on before connecting a mailbox watched
    // drafted fall and failed rise with no explanation anywhere on the page.
    const ledger = sendLedger();
    const deps = baseDeps({ resolveEmailConnectionImpl: vi.fn(async () => null) });
    const result = await processOutreachSweep(deps);
    expect(result.sent).toBe(0);
    expect(result.notes).toContainEqual({
      businessId: BIZ,
      note: "no mailbox connected to send from"
    });
    expect(ledger.transitionProspect).not.toHaveBeenCalled();
    expect(
      (deps as unknown as { sendEmailImpl: ReturnType<typeof vi.fn> }).sendEmailImpl
    ).not.toHaveBeenCalled();
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

  it("does not follow up with a prospect who already booked or advanced", async () => {
    // The gap this closes: the nudge is scheduled off SILENCE, and the only
    // thing that ever counted as noise was an inbound EMAIL. A prospect who
    // took a slot from the link in the pitch, met, and signed was still
    // silent by that definition, so "I wrote last week..." went to a
    // customer.
    const ledger = nudgeLedger();
    const deps = baseDeps({
      findEngagedImpl: vi.fn(async () => ({
        engaged: new Set([prospect().id]),
        readFailed: false
      }))
    });
    const result = await processOutreachSweep(deps);
    expect(result.nudged).toBe(0);
    expect(result.skipped).toBe(1);
    // Never claimed, so the one follow-up a prospect ever gets is still
    // theirs if the owner decides to reach out later.
    expect(ledger.claimProspectNudge).not.toHaveBeenCalled();
    expect(ledger.patchProspect).not.toHaveBeenCalledWith(
      BIZ,
      prospect().id,
      expect.objectContaining({ nudged_at: expect.anything() }),
      expect.anything()
    );
  });

  it("checks engagement BEFORE claiming, so the common case never undoes", async () => {
    const ledger = nudgeLedger();
    const findEngagedImpl = vi.fn(async () => ({
      engaged: new Set<string>(),
      readFailed: false
    }));
    await processOutreachSweep(baseDeps({ findEngagedImpl }));
    expect(findEngagedImpl).toHaveBeenCalled();
    const engagedAt = findEngagedImpl.mock.invocationCallOrder[0];
    const claimedAt = (ledger.claimProspectNudge as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(engagedAt).toBeLessThan(claimedAt);
  });

  it("holds the whole batch, and says so, when engagement cannot be read", async () => {
    // Fail-safe: a duplicate cold email is a spam complaint while a missed
    // one costs nothing. Nothing is stamped, so the same prospects are due
    // again in five minutes; only a PERSISTENT failure stops follow-ups, and
    // the note is how that stops being silent.
    const ledger = nudgeLedger();
    const deps = baseDeps({
      findEngagedImpl: vi.fn(async () => ({ engaged: new Set<string>(), readFailed: true }))
    });
    const result = await processOutreachSweep(deps);
    expect(result.nudged).toBe(0);
    expect(ledger.claimProspectNudge).not.toHaveBeenCalled();
    expect(result.notes.some((n) => n.note.includes("held this pass's follow-ups"))).toBe(
      true
    );
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

  it("counts text made only of blank lines as empty, before it can be split away", async () => {
    // The failure this guards: text that is truthy on the way in but splits to
    // no paragraphs would save a pitch that is only CTA, signature, and
    // footer, and it would still be sendable. The trim runs first, so every
    // shape of blank line is refused here rather than emptied later.
    const ledger = draftLedger();
    for (const paragraphs of ["\n\n", "  \n\n  ", "\n \n \n", "\r\n\r\n", "\t\n\n\t"]) {
      expect(
        await editProspectDraft(BIZ, prospect().id, { subject: "s", paragraphs }, baseDeps())
      ).toEqual({ ok: false, reason: "empty_text" });
    }
    expect(ledger.transitionProspect).not.toHaveBeenCalled();
  });

  it("never writes a draft whose paragraphs are empty", async () => {
    // The invariant stated as an assertion on the write itself, so it holds
    // however the text arrived.
    const ledger = draftLedger();
    await editProspectDraft(
      BIZ,
      prospect().id,
      { subject: "s", paragraphs: "\n\n  Still something to say.  \n\n" },
      baseDeps()
    );
    const patch = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(patch.pitch_paragraphs).toBe("Still something to say.");
    expect(patch.pitch_body.startsWith("Still something to say.")).toBe(true);
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

describe("rewriteAllProspectDrafts (Write it again, for every waiting draft)", () => {
  /** The drafts a run has not reached yet, in the order the cursor hands them over. */
  function queue(n: number, over: Partial<OutreachProspectRow> = {}): OutreachProspectRow[] {
    return Array.from({ length: n }, (_, i) =>
      prospect({ id: `p-${i}`, business_name: `Prospect ${i}`, ...over })
    );
  }

  it("rewrites the batch, hands back a cursor, and reports what is left", async () => {
    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsToRewrite: vi.fn(async () => queue(3)),
      countProspectsToRewrite: vi.fn(async () => 140)
    });
    const result = await rewriteAllProspectDrafts(BIZ, {}, baseDeps());
    expect(result).toEqual({
      ok: true,
      // The run's own clock, so every later batch reads the same slice
      // boundary rather than a moving "now".
      startedAt: MONDAY_MORNING.toISOString(),
      rewritten: 3,
      skipped: 0,
      remaining: 140
    });
    expect(ledger.listProspectsToRewrite).toHaveBeenCalledWith(
      BIZ,
      MONDAY_MORNING.toISOString(),
      REWRITE_BATCH_SIZE,
      expect.anything()
    );
    // Three drafts rewritten means three guarded writes, each still keyed on
    // the row being a draft.
    const writes = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes).toHaveLength(3);
    expect(writes.map((c) => c[1])).toEqual(["p-0", "p-1", "p-2"]);
    expect(writes.every((c) => c[2] === "drafted")).toBe(true);
  });

  it("writes the same email the single-draft button writes", async () => {
    // The two buttons share one composer on purpose: a bulk rewrite that
    // produced a subtly different email from the one the owner previewed by
    // pressing Write it again on a single draft would be the worst kind of
    // surprise, since it lands on every draft at once.
    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsToRewrite: vi.fn(async () => [prospect()])
    });
    const bulk = await rewriteAllProspectDrafts(BIZ, {}, baseDeps());
    const bulkPatch = (
      (await import("@/lib/outreach/db")).transitionProspect as ReturnType<typeof vi.fn>
    ).mock.calls[0][3];
    expect(bulk.ok).toBe(true);

    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      getProspect: vi.fn(async () => prospect())
    });
    const single = await regenerateProspectDraft(BIZ, prospect().id, baseDeps());
    expect(single).toEqual({ ok: true, prospect: bulkPatch });
  });

  it("picks up the settings the owner just changed, which is the whole point", async () => {
    // The drafts outlive the settings that produced them. Change the offer and
    // the queue still holds the old wording until something rewrites it.
    stubLedger({
      getOutreachSettings: vi.fn(async () =>
        settings({ mode: "manual", value_prop: "We give you an AI coworker.", sender_name: "Bri" })
      ),
      listProspectsToRewrite: vi.fn(async () => [prospect()])
    });
    await rewriteAllProspectDrafts(BIZ, {}, baseDeps());
    const patch = (
      (await import("@/lib/outreach/db")).transitionProspect as ReturnType<typeof vi.fn>
    ).mock.calls[0][3];
    expect(patch.pitch_paragraphs).toContain("We give you an AI coworker.");
    expect(patch.pitch_body).toContain("Bri");
    // Still no footer inside the editable paragraphs, and still assembled
    // around them.
    expect(patch.pitch_paragraphs).not.toContain("/api/outreach/unsubscribe?");
    expect(patch.pitch_body).toContain("/api/outreach/unsubscribe?");
  });

  it("re-composes from the stored findings, so a bulk press never re-probes anyone", async () => {
    // A button that fetches a few hundred strangers' websites on one click is a
    // different thing from a button that rewrites a few hundred emails.
    const probeSiteImpl = vi.fn(async () => ({ reachable: false as const, failure: "no" }));
    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsToRewrite: vi.fn(async () => queue(5))
    });
    await rewriteAllProspectDrafts(BIZ, {}, baseDeps({ probeSiteImpl }));
    expect(probeSiteImpl).not.toHaveBeenCalled();
  });

  it("carries the caller's cursor instead of starting a fresh slice each batch", async () => {
    // Without this, batch two would re-read the rows batch one just stamped,
    // and a long queue would never finish.
    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsToRewrite: vi.fn(async () => [])
    });
    const since = "2026-08-19T05:09:13.000Z";
    const result = await rewriteAllProspectDrafts(BIZ, { since }, baseDeps());
    expect(result).toEqual({ ok: true, startedAt: since, rewritten: 0, skipped: 0, remaining: 0 });
    expect(ledger.listProspectsToRewrite).toHaveBeenCalledWith(
      BIZ,
      since,
      REWRITE_BATCH_SIZE,
      expect.anything()
    );
  });

  it("stamps a draft it cannot rewrite, so the cursor cannot stall on it", async () => {
    // A row whose findings no longer say anything checkable is left as it is,
    // but it still sits before the cursor. Without the stamp every later batch
    // would read the same row back and the loop would never end.
    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsToRewrite: vi.fn(async () => [prospect({ id: "p-stuck", findings: [] })])
    });
    expect(await rewriteAllProspectDrafts(BIZ, {}, baseDeps())).toEqual({
      ok: true,
      startedAt: MONDAY_MORNING.toISOString(),
      rewritten: 0,
      skipped: 1,
      remaining: 0
    });
    const writes = (ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes).toHaveLength(1);
    // Nothing but the timestamp, and still guarded on the row being a draft.
    expect(writes[0][1]).toBe("p-stuck");
    expect(writes[0][2]).toBe("drafted");
    expect(writes[0][3]).toEqual({});
  });

  it("counts a draft that stopped being one as skipped, and does not touch it again", async () => {
    // The sweep can send a draft between the batch read and the batch write.
    // The guarded write reports that, and there is nothing to stamp: a sent row
    // is no longer in the cursor's window at all.
    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsToRewrite: vi.fn(async () => [prospect()]),
      transitionProspect: vi.fn(async () => false)
    });
    expect(await rewriteAllProspectDrafts(BIZ, {}, baseDeps())).toMatchObject({
      ok: true,
      rewritten: 0,
      skipped: 1
    });
    expect((ledger.transitionProspect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("refuses an unconfigured or downgraded tenant before spending a single model call", async () => {
    stubLedger({ getOutreachSettings: vi.fn(async () => null) });
    expect(await rewriteAllProspectDrafts(BIZ, {}, baseDeps())).toEqual({
      ok: false,
      reason: "not_configured"
    });

    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsToRewrite: vi.fn(async () => queue(3))
    });
    const polishImpl = vi.fn(async (_biz: string, paragraphs: string[]) => paragraphs);
    expect(
      await rewriteAllProspectDrafts(
        BIZ,
        {},
        baseDeps({
          polishImpl,
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
    // A bulk press is the expensive one to get wrong: the tier gate runs before
    // the queue is even read.
    expect(ledger.listProspectsToRewrite).not.toHaveBeenCalled();
    expect(polishImpl).not.toHaveBeenCalled();

    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual", postal_address: null }))
    });
    expect(await rewriteAllProspectDrafts(BIZ, {}, baseDeps())).toEqual({
      ok: false,
      reason: "not_configured",
      detail: "no postal address configured"
    });
  });
});

describe("sendProspectNow with no mailbox (the owner pressed Send too early)", () => {
  it("refuses without touching the draft", async () => {
    // One press used to claim the draft, fail the send, and stamp it `failed`,
    // which is terminal: the owner lost the draft as well as the send, and the
    // fix (connect a mailbox) could not bring it back.
    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      getProspect: vi.fn(async () => prospect())
    });
    const result = await sendProspectNow(
      BIZ,
      prospect().id,
      baseDeps({ resolveEmailConnectionImpl: vi.fn(async () => null) })
    );
    expect(result).toEqual({
      ok: false,
      reason: "no_mailbox",
      detail: "no mailbox connected to send from"
    });
    expect(ledger.transitionProspect).not.toHaveBeenCalled();
    expect(ledger.patchProspect).not.toHaveBeenCalled();
  });
});

describe("sendDraftsNow (the owner pressed Send all)", () => {
  function sendable(n: number): OutreachProspectRow[] {
    return Array.from({ length: n }, (_, i) => prospect({ id: `s-${i}` }));
  }

  it("sends inside today's cap and reports what is left over", async () => {
    // "All" cannot mean all: a few hundred cold emails leaving one mailbox in
    // a burst is how a sending domain gets rate limited, and the cap is the
    // tenant's own rule. It is enforced, and the leftover is reported rather
    // than silently dropped.
    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual", daily_cap: 3 })),
      listProspectsByStatus: vi.fn(async () => sendable(3)),
      countProspectsSentSince: vi.fn(async () => 1),
      countProspectsByStatus: vi.fn(async () => 20)
    });
    const result = await sendDraftsNow(BIZ, baseDeps());
    expect(result).toMatchObject({ ok: true, sent: 3, remaining: 20, allowanceLeft: 0 });
  });

  it("counts follow-ups against the same allowance, because a nudge is cold mail too", async () => {
    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual", daily_cap: 5 })),
      listProspectsByStatus: vi.fn(async () => []),
      countProspectsSentSince: vi.fn(async () => 2),
      countProspectsNudgedSince: vi.fn(async () => 3)
    });
    const result = await sendDraftsNow(BIZ, baseDeps());
    expect(result).toMatchObject({ ok: true, sent: 0, allowanceLeft: 0 });
  });

  it("sends nothing at all once the cap is spent, without claiming a single draft", async () => {
    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual", daily_cap: 2 })),
      listProspectsByStatus: vi.fn(async () => sendable(5)),
      countProspectsSentSince: vi.fn(async () => 2)
    });
    expect(await sendDraftsNow(BIZ, baseDeps())).toMatchObject({ ok: true, sent: 0 });
    // Not even read: over the cap there is nothing to do, and claiming a row
    // it cannot send would strand it.
    expect(ledger.listProspectsByStatus).not.toHaveBeenCalled();
  });

  it("caps one request at the batch size, so the caller loops instead of timing out", async () => {
    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual", daily_cap: 200 })),
      listProspectsByStatus: vi.fn(async () => [])
    });
    await sendDraftsNow(BIZ, baseDeps());
    expect(ledger.listProspectsByStatus).toHaveBeenCalledWith(
      BIZ,
      ["drafted"],
      SEND_NOW_BATCH,
      expect.anything()
    );
  });

  it("ignores the send window, because the owner is choosing this moment", async () => {
    // The single Send button beside each draft ignores it for the same reason.
    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsByStatus: vi.fn(async () => sendable(1))
    });
    const result = await sendDraftsNow(BIZ, baseDeps({ now: () => MONDAY_AFTERNOON }));
    expect(result).toMatchObject({ ok: true, sent: 1 });
  });

  it("carries the send's own notes back, so a filed-nowhere prospect is visible", async () => {
    // The mail went out but no flow matched it, so nothing filed the prospect
    // and nobody was told. That is the note the sweep already records, and a
    // manual press must not swallow it just because there is no cron log to
    // read afterwards.
    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsByStatus: vi.fn(async () => sendable(1))
    });
    const result = await sendDraftsNow(
      BIZ,
      baseDeps({
        processFlowEventImpl: vi.fn(async () => ({
          enqueued: 0,
          flowsEvaluated: 1,
          flowsMatched: 0
        }))
      })
    );
    expect(result).toMatchObject({ ok: true, sent: 1 });
    expect(result.ok && result.notes).toEqual([
      "no flow matched, so the prospect was emailed but not filed"
    ]);
  });

  it("refuses before claiming anything when there is no mailbox, or no plan", async () => {
    const ledger = stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })),
      listProspectsByStatus: vi.fn(async () => sendable(3))
    });
    expect(
      await sendDraftsNow(BIZ, baseDeps({ resolveEmailConnectionImpl: vi.fn(async () => null) }))
    ).toEqual({
      ok: false,
      reason: "no_mailbox",
      detail: "no mailbox connected to send from"
    });
    expect(ledger.listProspectsByStatus).not.toHaveBeenCalled();

    stubLedger({ getOutreachSettings: vi.fn(async () => null) });
    expect(await sendDraftsNow(BIZ, baseDeps())).toEqual({ ok: false, reason: "not_configured" });

    stubLedger({ getOutreachSettings: vi.fn(async () => settings({ mode: "manual" })) });
    expect(
      await sendDraftsNow(
        BIZ,
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

    // Classified by the discriminant, not by matching the note's wording: a
    // config gap is not a plan problem, and telling a paying tenant to upgrade
    // over a missing footer address would be the wrong instruction entirely.
    stubLedger({
      getOutreachSettings: vi.fn(async () => settings({ mode: "manual", postal_address: null }))
    });
    expect(await sendDraftsNow(BIZ, baseDeps())).toEqual({
      ok: false,
      reason: "not_configured",
      detail: "no postal address configured"
    });
  });
});

describe("the Contacted stage (an emailed prospect is not a new lead)", () => {
  it("moves everyone emailed recently, and does it on a LATER pass than the send", async () => {
    // The board is keyed on contacts, and a cold-emailed prospect has none at
    // the moment the mail leaves: the outreach flow files them about a minute
    // afterwards. Measured on the live tenant: a send at 00:55:59 produced a
    // contact at 00:57:02. Firing inside the send would tag nothing, and the
    // flow would then file them as "New Lead", sitting beside leads nobody has
    // touched while the Contacted column read zero.
    const emailed = prospect({ id: "p-sent", phone: "(480) 999-5302" });
    const ledger = stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ mode: "manual" })]),
      listProspectsContactedSince: vi.fn(async () => [emailed])
    });
    const fireLifecycleStageImpl = vi.fn(async () => "moved" as const);
    await processOutreachSweep(baseDeps({ fireLifecycleStageImpl }));
    expect(fireLifecycleStageImpl).toHaveBeenCalledWith(
      BIZ,
      "(480) 999-5302",
      "contacted",
      { dedupeSuffix: "p-sent" }
    );
    // Bounded and recent: this runs every pass, so it must never be a scan.
    const call = (ledger.listProspectsContactedSince as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1] < MONDAY_MORNING.toISOString()).toBe(true);
    expect(typeof call[2]).toBe("number");
  });

  it("runs for a manual tenant too, and outside the send window", async () => {
    // A manual tenant sends with the Send button, so their board deserves the
    // same truth. Reading and tagging is not sending, so neither the window nor
    // the cap has any claim on it.
    const fireLifecycleStageImpl = vi.fn(async () => "moved" as const);
    stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ mode: "manual" })]),
      listProspectsContactedSince: vi.fn(async () => [prospect({ phone: "+14809995302" })])
    });
    await processOutreachSweep(baseDeps({ fireLifecycleStageImpl, now: () => MONDAY_AFTERNOON }));
    expect(fireLifecycleStageImpl).toHaveBeenCalledWith(
      BIZ,
      "+14809995302",
      "contacted",
      expect.anything()
    );
  });

  it("stamps what it handled, so the queue drains instead of re-reading the same rows", async () => {
    // Without the marker this phase can only read "recently emailed", which is
    // a window it cannot work through: a tenant near the 200/day ceiling has
    // more prospects in the window than one pass may read, the same rows come
    // back every pass, and everything behind them ages out still in New Lead.
    const ledger = stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ mode: "manual" })]),
      listProspectsContactedSince: vi.fn(async () => [prospect({ id: "p-done" })])
    });
    await processOutreachSweep(baseDeps());
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      "p-done",
      { contacted_stage_at: MONDAY_MORNING.toISOString() },
      expect.anything()
    );
  });

  it("leaves a genuinely racing prospect unstamped, so a later pass retries it", async () => {
    // The contact does not exist YET: the outreach flow files it about a minute
    // after the send. Stamping that would abandon the prospect in New Lead for
    // good, which is the exact bug this phase exists to fix.
    const ledger = stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ mode: "manual" })]),
      listProspectsContactedSince: vi.fn(async () => [
        prospect({ id: "p-early", sent_at: new Date(MONDAY_MORNING.getTime() - 60_000).toISOString() })
      ])
    });
    await processOutreachSweep(
      baseDeps({ fireLifecycleStageImpl: vi.fn(async () => "no_contact" as const) })
    );
    expect(ledger.patchProspect).not.toHaveBeenCalled();
  });

  it("stops waiting for a contact that is never coming, so it cannot starve the queue", async () => {
    // Past the grace window "no contact" is an answer, not a race: the tenant's
    // outreach flow is off, or filing failed, or the number will not normalize.
    // Left unstamped forever those rows collect at the head of an oldest-first
    // capped queue and starve every prospect behind them whose contact DOES
    // exist, until those age out of the window still in New Lead.
    const ledger = stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ mode: "manual" })]),
      listProspectsContactedSince: vi.fn(async () => [
        prospect({
          id: "p-hopeless",
          sent_at: new Date(MONDAY_MORNING.getTime() - 2 * 60 * 60 * 1000).toISOString()
        })
      ])
    });
    await processOutreachSweep(
      baseDeps({ fireLifecycleStageImpl: vi.fn(async () => "no_contact" as const) })
    );
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      "p-hopeless",
      { contacted_stage_at: MONDAY_MORNING.toISOString() },
      expect.anything()
    );
  });

  it("stops waiting on a prospect with no send stamp at all", async () => {
    // Defensive: a row in this queue always has sent_at, but a null one must
    // read as "long past the race" rather than sitting in it forever.
    const ledger = stubLedger({
      listActiveOutreachSettings: vi.fn(async () => [settings({ mode: "manual" })]),
      listProspectsContactedSince: vi.fn(async () => [prospect({ id: "p-nostamp", sent_at: null })])
    });
    await processOutreachSweep(
      baseDeps({ fireLifecycleStageImpl: vi.fn(async () => "no_contact" as const) })
    );
    expect(ledger.patchProspect).toHaveBeenCalledWith(
      BIZ,
      "p-nostamp",
      { contacted_stage_at: MONDAY_MORNING.toISOString() },
      expect.anything()
    );
  });

  it("never lets the list read stop the mail either", async () => {
    // The per-prospect catch does not cover this one: the query runs before the
    // loop, and the phase runs before the send.
    stubLedger({
      listProspectsByStatus: vi.fn(async (_b: string, statuses: string[]) =>
        statuses.includes("drafted") ? [prospect()] : []
      ),
      listProspectsContactedSince: vi.fn(async () => {
        throw new Error("read exploded");
      })
    });
    const result = await processOutreachSweep(baseDeps());
    expect(result.errors).toEqual([]);
    expect(result.sent).toBe(1);
    expect(result.notes).toContainEqual({
      businessId: BIZ,
      note: "could not move emailed prospects to Contacted: read exploded"
    });
  });

  it("never lets an unmovable board stop the mail", async () => {
    // The sweep's job is sending. A stage that will not move is a cosmetic
    // problem and must not become an outage.
    // A sendable queue, so the assertion that the mail still went out is real.
    // However it failed: a thrown string is not an Error, and reading .message
    // off one would record "undefined" as the reason.
    for (const thrown of [new Error("board exploded"), "board exploded"]) {
      stubLedger({
        listProspectsByStatus: vi.fn(async (_b: string, statuses: string[]) =>
          statuses.includes("drafted") ? [prospect()] : []
        ),
        listProspectsContactedSince: vi.fn(async () => [prospect()])
      });
      const result = await processOutreachSweep(
        baseDeps({
          fireLifecycleStageImpl: vi.fn(async () => {
            throw thrown;
          })
        })
      );
      // Recorded, not swallowed, and the pass carried on: this phase runs
      // BEFORE the send, so an exception escaping it would stop the mail.
      expect(result.errors).toEqual([]);
      expect(result.notes).toContainEqual({
        businessId: BIZ,
        note: "could not move emailed prospects to Contacted: board exploded"
      });
      expect(result.sent).toBe(1);
    }
  });
});
