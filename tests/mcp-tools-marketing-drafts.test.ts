/**
 * Marketing outreach draft tools (src/lib/mcp/tools/marketing-drafts.ts):
 * the Drafts to review queue reachable from a connector.
 *
 * The contract under test: the caller supplies PARAGRAPHS and the footer is
 * appended by the same code the dashboard uses (so the tools call the shared
 * outreach functions rather than writing rows themselves), every refusal the
 * dashboard route knows is surfaced as an owner-readable tool error, the
 * role bar is `manage_settings` like the dashboard outreach routes, and the
 * mode is reported so a caller in `auto` mode knows the draft will be sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/outreach/db", () => ({
  getOutreachSettings: vi.fn(),
  listProspectsByStatus: vi.fn(),
  countProspectsByStatus: vi.fn(),
  getProspect: vi.fn()
}));
vi.mock("@/lib/outreach/owner", () => ({ skipProspect: vi.fn() }));
vi.mock("@/lib/outreach/sweep", () => ({
  createProspectDraft: vi.fn(),
  editProspectDraft: vi.fn()
}));

import { McpToolError, requireMcpBusinessRole } from "@/lib/mcp/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  countProspectsByStatus,
  getOutreachSettings,
  getProspect,
  listProspectsByStatus
} from "@/lib/outreach/db";
import { skipProspect } from "@/lib/outreach/owner";
import { createProspectDraft, editProspectDraft } from "@/lib/outreach/sweep";
import {
  createMarketingDraftTool,
  listMarketingDraftsTool,
  marketingDraftTools,
  updateMarketingDraftTool
} from "@/lib/mcp/tools/marketing-drafts";
import { runTool } from "./helpers/run-mcp-tool";

const AUTH = { userId: "user-1", email: "owner@biz.com" };
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";

function row(over: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    business_id: "biz-1",
    domain: "wolfgangscooling.com",
    business_name: "Wolfgangs Cooling, Heating & Plumbing",
    email: "andrea.martinez@turnpointservices.com",
    phone: null,
    website: "https://wolfgangscooling.com",
    vertical: "hvac",
    city: "Tempe AZ",
    google_hours: null,
    rating: null,
    review_count: null,
    findings: [],
    pitch_subject: "Wolfgangs Cooling, Heating & Plumbing: the customers who would rather text",
    pitch_paragraphs: "Hi Wolfgangs Cooling, Heating & Plumbing,\n\nI was looking you up in Tempe AZ.",
    pitch_body:
      "Hi Wolfgangs Cooling, Heating & Plumbing,\n\nI was looking you up in Tempe AZ.\n\nYou can grab a time here: https://www.example.com/book/hq/discovery-call\n\nSam\nExample Co\n\nYou can unsubscribe here: https://x/api/outreach/unsubscribe?p=1\n1 Example Plaza\n",
    status: "drafted",
    status_detail: null,
    contact_id: null,
    drafted_at: "2026-09-05T04:00:00Z",
    queued_at: null,
    sent_at: null,
    nudged_at: null,
    contacted_stage_at: null,
    replied_at: null,
    created_at: "2026-09-05T04:00:00Z",
    updated_at: "2026-09-05T04:00:00Z",
    ...over
  };
}

const CREATE_ARGS = {
  business_name: "Wolfgangs Cooling, Heating & Plumbing",
  email: "Andrea.Martinez@turnpointservices.com",
  city: "Tempe AZ",
  subject: "Wolfgangs Cooling, Heating & Plumbing: the customers who would rather text",
  paragraphs: "Hi Wolfgangs Cooling, Heating & Plumbing,\n\nI was looking you up in Tempe AZ."
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner");
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 30, remaining: 29, reset: 0 });
  vi.mocked(getOutreachSettings).mockResolvedValue({ mode: "manual" } as never);
  vi.mocked(listProspectsByStatus).mockResolvedValue([row() as never]);
  vi.mocked(countProspectsByStatus).mockResolvedValue(11);
  vi.mocked(getProspect).mockResolvedValue(row() as never);
});

describe("the module exports the three tools", () => {
  it("in list, create, update order", () => {
    expect(marketingDraftTools.map((t) => t.name)).toEqual([
      "list_marketing_drafts",
      "create_marketing_draft",
      "update_marketing_draft"
    ]);
  });
});

describe("list_marketing_drafts", () => {
  it("returns the review queue in the panel's shape, without the assembled footer", async () => {
    const result = (await runTool(listMarketingDraftsTool, {}, AUTH)) as {
      mode: string;
      waiting: number;
      drafts: Array<Record<string, unknown>>;
    };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    // Drafted only, oldest first, the dashboard's default page size.
    expect(listProspectsByStatus).toHaveBeenCalledWith("biz-1", ["drafted"], 25);
    expect(countProspectsByStatus).toHaveBeenCalledWith("biz-1", "drafted");
    expect(result.mode).toBe("manual");
    expect(result.waiting).toBe(11);
    expect(result.drafts).toEqual([
      {
        draft_id: DRAFT_ID,
        business_name: "Wolfgangs Cooling, Heating & Plumbing",
        email: "andrea.martinez@turnpointservices.com",
        domain: "wolfgangscooling.com",
        city: "Tempe AZ",
        vertical: "hvac",
        subject: "Wolfgangs Cooling, Heating & Plumbing: the customers who would rather text",
        paragraphs: "Hi Wolfgangs Cooling, Heating & Plumbing,\n\nI was looking you up in Tempe AZ.",
        status: "drafted",
        drafted_at: "2026-09-05T04:00:00Z"
      }
    ]);
    // The wire shape never carries pitch_body: the footer is not the caller's
    // to see as editable text, and the panel shows it read-only for the same
    // reason.
    expect(JSON.stringify(result)).not.toContain("unsubscribe");
  });

  it("honors an explicit limit and reads mode off when Prospecting was never opened", async () => {
    vi.mocked(getOutreachSettings).mockResolvedValue(null);
    vi.mocked(listProspectsByStatus).mockResolvedValue([]);
    vi.mocked(countProspectsByStatus).mockResolvedValue(0);
    const result = await runTool(listMarketingDraftsTool, { limit: 5 }, AUTH);
    expect(listProspectsByStatus).toHaveBeenCalledWith("biz-1", ["drafted"], 5);
    expect(result).toEqual({ mode: "off", waiting: 0, drafts: [] });
  });

  it("passes an explicit business_id through and role-checks it", async () => {
    await runTool(listMarketingDraftsTool, { business_id: "biz-9" }, AUTH);
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-9", "manage_settings");
    expect(listProspectsByStatus).toHaveBeenCalledWith("biz-9", ["drafted"], 25);
  });
});

describe("create_marketing_draft", () => {
  it("files the draft through the shared create path and reports the assembled email", async () => {
    vi.mocked(createProspectDraft).mockResolvedValue({
      ok: true,
      prospect: row() as never,
      mode: "manual"
    });
    const result = await runTool(
      createMarketingDraftTool,
      {
        ...CREATE_ARGS,
        domain: "wolfgangscooling.com",
        vertical: "hvac",
        website: "https://wolfgangscooling.com",
        phone: "(480) 555-0100"
      },
      AUTH
    );
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    expect(rateLimit).toHaveBeenCalledWith("mcp-outreach-draft:biz-1", {
      interval: 60_000,
      maxRequests: 30
    });
    // The tool never touches the ledger itself: everything goes through the
    // same function the sweep's drafting phase shares its assembly with.
    expect(createProspectDraft).toHaveBeenCalledWith("biz-1", {
      businessName: CREATE_ARGS.business_name,
      email: CREATE_ARGS.email,
      city: "Tempe AZ",
      subject: CREATE_ARGS.subject,
      paragraphs: CREATE_ARGS.paragraphs,
      domain: "wolfgangscooling.com",
      vertical: "hvac",
      website: "https://wolfgangscooling.com",
      phone: "(480) 555-0100"
    });
    expect(result).toEqual({
      created: true,
      draft_id: DRAFT_ID,
      mode: "manual",
      subject: row().pitch_subject,
      paragraphs: row().pitch_paragraphs,
      assembled_body: row().pitch_body
    });
  });

  it("defaults city to blank and leaves the optional fields undefined", async () => {
    vi.mocked(createProspectDraft).mockResolvedValue({
      ok: true,
      prospect: row({ city: "" }) as never,
      mode: "auto"
    });
    const { city: _city, ...noCity } = CREATE_ARGS;
    void _city;
    const result = (await runTool(createMarketingDraftTool, noCity, AUTH)) as { mode: string };
    expect(createProspectDraft).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({
        city: "",
        domain: undefined,
        vertical: undefined,
        website: undefined,
        phone: undefined
      })
    );
    // Auto mode is reported, because the sweep will send this without a
    // human pressing Send.
    expect(result.mode).toBe("auto");
  });

  it("surfaces every create refusal as an owner-readable error, with the detail", async () => {
    const cases: Array<[string, RegExp]> = [
      ["not_configured", /Finish setting up Prospecting/],
      ["tier_blocked", /Standard plan/],
      ["empty_text", /subject line and something to say/],
      ["too_long", /longer than a cold email/],
      ["invalid_domain", /Pass `domain`/],
      ["duplicate", /nobody is cold-emailed twice/]
    ];
    for (const [reason, pattern] of cases) {
      vi.mocked(createProspectDraft).mockResolvedValue({ ok: false, reason } as never);
      await expect(runTool(createMarketingDraftTool, CREATE_ARGS, AUTH)).rejects.toThrow(pattern);
    }
    vi.mocked(createProspectDraft).mockResolvedValue({
      ok: false,
      reason: "not_configured",
      detail: "no postal address configured"
    });
    await expect(runTool(createMarketingDraftTool, CREATE_ARGS, AUTH)).rejects.toThrow(
      /Finish setting up Prospecting.*\(no postal address configured\)/
    );
  });

  it("refuses when rate limited, before anything is written", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 30, remaining: 0, reset: 0 });
    await expect(runTool(createMarketingDraftTool, CREATE_ARGS, AUTH)).rejects.toBeInstanceOf(
      McpToolError
    );
    expect(createProspectDraft).not.toHaveBeenCalled();
  });

  it("requires manage_settings, the dashboard outreach routes' bar", async () => {
    vi.mocked(requireMcpBusinessRole).mockRejectedValueOnce(new McpToolError("nope"));
    await expect(runTool(createMarketingDraftTool, CREATE_ARGS, AUTH)).rejects.toThrow("nope");
    expect(createProspectDraft).not.toHaveBeenCalled();
  });
});

describe("update_marketing_draft", () => {
  const EDITED = {
    pitch_subject: "New subject",
    pitch_paragraphs: "New body.",
    pitch_body: "New body.\n\nYou can grab a time here: https://x\n\nBrian\n\nunsubscribe\n"
  };

  it("edits subject and paragraphs together, like the dashboard's Save draft", async () => {
    vi.mocked(editProspectDraft).mockResolvedValue({ ok: true, prospect: EDITED });
    const result = await runTool(
      updateMarketingDraftTool,
      { draft_id: DRAFT_ID, subject: "New subject", paragraphs: "New body." },
      AUTH
    );
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    expect(editProspectDraft).toHaveBeenCalledWith("biz-1", DRAFT_ID, {
      subject: "New subject",
      paragraphs: "New body."
    });
    expect(result).toEqual({
      draft_id: DRAFT_ID,
      status: "edited",
      subject: "New subject",
      paragraphs: "New body.",
      assembled_body: EDITED.pitch_body
    });
    expect(skipProspect).not.toHaveBeenCalled();
  });

  it("fills the field the caller left out from the stored draft", async () => {
    vi.mocked(editProspectDraft).mockResolvedValue({ ok: true, prospect: EDITED });
    await runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, subject: "Only subject" }, AUTH);
    expect(editProspectDraft).toHaveBeenCalledWith("biz-1", DRAFT_ID, {
      subject: "Only subject",
      paragraphs: row().pitch_paragraphs
    });

    await runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, paragraphs: "Only body." }, AUTH);
    expect(editProspectDraft).toHaveBeenLastCalledWith("biz-1", DRAFT_ID, {
      subject: row().pitch_subject,
      paragraphs: "Only body."
    });
  });

  it("hands a legacy draft's null text to the edit path as blank, so it refuses honestly", async () => {
    // A draft written before pitch_paragraphs existed has nothing owner-safe
    // to hand back, and the shared edit path answers empty_text. The tool
    // must not invent paragraphs from pitch_body, which carries the footer.
    vi.mocked(getProspect).mockResolvedValue(
      row({ pitch_subject: null, pitch_paragraphs: null }) as never
    );
    vi.mocked(editProspectDraft).mockResolvedValue({ ok: false, reason: "empty_text" });
    await expect(
      runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, subject: "s" }, AUTH)
    ).rejects.toThrow(/subject line and something to say/);
    expect(editProspectDraft).toHaveBeenCalledWith("biz-1", DRAFT_ID, {
      subject: "s",
      paragraphs: ""
    });
  });

  it("skips through the dashboard's own skipProspect and reports a stale queue", async () => {
    vi.mocked(skipProspect).mockResolvedValue(true);
    const result = await runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, skip: true }, AUTH);
    expect(skipProspect).toHaveBeenCalledWith("biz-1", DRAFT_ID);
    expect(result).toEqual({
      draft_id: DRAFT_ID,
      status: "skipped",
      subject: null,
      paragraphs: null,
      assembled_body: null
    });
    expect(editProspectDraft).not.toHaveBeenCalled();

    // The queue can be minutes stale: a skip that finds no draft is refused
    // rather than answered with a cheerful success.
    vi.mocked(skipProspect).mockResolvedValue(false);
    await expect(
      runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, skip: true }, AUTH)
    ).rejects.toThrow(/already been sent or skipped/);
  });

  it("refuses an empty update, and skip combined with an edit", async () => {
    await expect(runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID }, AUTH)).rejects.toThrow(
      /Nothing to update/
    );
    await expect(
      runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, skip: false }, AUTH)
    ).rejects.toThrow(/Nothing to update/);
    await expect(
      runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, skip: true, subject: "s" }, AUTH)
    ).rejects.toThrow(/not both/);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(skipProspect).not.toHaveBeenCalled();
    expect(editProspectDraft).not.toHaveBeenCalled();
  });

  it("refuses a draft that is gone or no longer a draft before calling the edit path", async () => {
    vi.mocked(getProspect).mockResolvedValue(null);
    await expect(
      runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, subject: "s" }, AUTH)
    ).rejects.toThrow(/no longer in the list/);

    vi.mocked(getProspect).mockResolvedValue(row({ status: "sent" }) as never);
    await expect(
      runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, subject: "s" }, AUTH)
    ).rejects.toThrow(/already been sent or skipped/);
    expect(editProspectDraft).not.toHaveBeenCalled();
  });

  it("surfaces every edit refusal the dashboard knows, with the detail", async () => {
    const cases: Array<[string, RegExp]> = [
      ["not_found", /no longer in the list/],
      ["not_drafted", /already been sent or skipped/],
      ["not_configured", /Finish setting up Prospecting/],
      ["tier_blocked", /Standard plan/],
      ["empty_text", /subject line and something to say/],
      ["too_long", /longer than a cold email/],
      ["not_pitchable", /Skip it instead/]
    ];
    for (const [reason, pattern] of cases) {
      vi.mocked(editProspectDraft).mockResolvedValue({ ok: false, reason } as never);
      await expect(
        runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, subject: "s" }, AUTH)
      ).rejects.toThrow(pattern);
    }
    vi.mocked(editProspectDraft).mockResolvedValue({
      ok: false,
      reason: "tier_blocked",
      detail: "prospecting requires the Standard plan"
    });
    await expect(
      runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, subject: "s" }, AUTH)
    ).rejects.toThrow(/Standard plan.*\(prospecting requires the Standard plan\)/);
  });

  it("refuses when rate limited, before any write", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 30, remaining: 0, reset: 0 });
    await expect(
      runTool(updateMarketingDraftTool, { draft_id: DRAFT_ID, skip: true }, AUTH)
    ).rejects.toBeInstanceOf(McpToolError);
    expect(skipProspect).not.toHaveBeenCalled();
    expect(getProspect).not.toHaveBeenCalled();
  });
});
