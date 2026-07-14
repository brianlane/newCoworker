/**
 * Direct tests for the branches of the shared customer-tool cores that the
 * route-level suites can't reach: the voice adapters validate phone shape
 * before calling, and the note/stamp caps make `note_too_long` unreachable
 * through the 1500-char route schema. Also the dashboard-surface rename
 * semantics of setCustomerDisplayName (owner authority: overwrite +
 * name_source='manual' + forced summary regeneration), which the voice
 * route suite deliberately never exercises.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/customer-memory/db", () => ({
  getCustomerMemory: vi.fn(),
  recordInteractionAndIncrement: vi.fn(),
  updateCustomerOwnerFields: vi.fn()
}));

vi.mock("@/lib/customer-memory/summarizer", () => ({
  summarizeCustomerMemoryAndLog: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockResolvedValue({ mocked: "client" })
}));

vi.mock("../supabase/functions/_shared/contact_context", () => ({
  loadContactTimeline: vi.fn()
}));

import {
  appendCustomerPinnedNote,
  lookupCustomerByPhone,
  setCustomerDisplayName,
  PINNED_MAX_CHARS
} from "@/lib/customer-tools/handlers";
import { getCustomerMemory, updateCustomerOwnerFields } from "@/lib/customer-memory/db";
import { summarizeCustomerMemoryAndLog } from "@/lib/customer-memory/summarizer";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { loadContactTimeline } from "../supabase/functions/_shared/contact_context";
import type { CustomerMemoryRow } from "@/lib/customer-memory/types";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15551234567";

function memory(overrides: Partial<CustomerMemoryRow> = {}): CustomerMemoryRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    business_id: BIZ,
    customer_e164: PHONE,
    type: "customer",
    name_source: "auto",
    sms_reply_mode: "auto",
    display_name: null,
    email: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 0,
    total_interaction_count: 0,
    last_interaction_at: null,
    last_summarized_at: null,
    last_channel: null,
    alias_e164s: [],
    tags: [],
    owner_employee_id: null,
    birthday: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lookupCustomerByPhone", () => {
  it("treats a malformed phone (spotty-CNAM 'anonymous') as nobody on file", async () => {
    const result = await lookupCustomerByPhone(BIZ, "anonymous");
    expect(result).toEqual({ ok: true, data: { found: false } });
    expect(vi.mocked(getCustomerMemory)).not.toHaveBeenCalled();
  });

  it("attaches the cross-channel recentInteractions timeline when one exists", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ display_name: "Alex" }));
    vi.mocked(loadContactTimeline).mockResolvedValueOnce(
      "Recent interactions…\n- [Contact (SMS)] July 23, 2026"
    );
    const result = await lookupCustomerByPhone(BIZ, PHONE);
    const customer = (result.data as { customer: Record<string, unknown> }).customer;
    expect(customer.recentInteractions).toContain("July 23, 2026");
    // One call with the queried number — the loader itself is alias-aware
    // (it resolves the profile's primary + merged numbers).
    expect(vi.mocked(loadContactTimeline)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadContactTimeline)).toHaveBeenCalledWith(
      { mocked: "client" },
      BIZ,
      PHONE
    );
  });

  it("omits recentInteractions when there is no timeline (nothing recent)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory());
    vi.mocked(loadContactTimeline).mockResolvedValueOnce(null);
    const result = await lookupCustomerByPhone(BIZ, PHONE);
    const customer = (result.data as { customer: Record<string, unknown> }).customer;
    expect("recentInteractions" in customer).toBe(false);
    expect(vi.mocked(loadContactTimeline)).toHaveBeenCalledTimes(1);
  });

  it("degrades to the summary-only shape when the timeline load blows up", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      memory({ summary_md: "rolling summary" })
    );
    vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce(new Error("no client"));
    const result = await lookupCustomerByPhone(BIZ, PHONE);
    const customer = (result.data as { customer: Record<string, unknown> }).customer;
    expect(customer.summary).toBe("rolling summary");
    expect("recentInteractions" in customer).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("setCustomerDisplayName (dashboard rename semantics)", () => {
  it("dashboard channel OVERWRITES an existing different name, stamps name_source='manual', and force-regenerates the summary", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      memory({ display_name: "Muhammad Fahad Juhu", name_source: "manual" })
    );
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);

    const result = await setCustomerDisplayName(BIZ, PHONE, "Juhu", "dashboard");

    expect(result).toEqual({
      ok: true,
      data: { updated: true, previous: "Muhammad Fahad Juhu" }
    });
    expect(vi.mocked(updateCustomerOwnerFields)).toHaveBeenCalledWith(BIZ, PHONE, {
      displayName: "Juhu",
      nameSource: "manual"
    });
    // The stale name lives in summary_md too — the rename must trigger a
    // FORCED regeneration (a rename adds no interaction, so the normal
    // threshold/debounce gates would skip it).
    expect(vi.mocked(summarizeCustomerMemoryAndLog)).toHaveBeenCalledWith(
      BIZ,
      PHONE,
      {},
      { force: true }
    );
  });

  it("dashboard channel is a no-op when the requested name already matches (no write, no re-summarize)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ display_name: "Juhu" }));

    const result = await setCustomerDisplayName(BIZ, PHONE, "Juhu", "dashboard");

    expect(result).toEqual({
      ok: true,
      data: { updated: false, reason: "name_already_set_matches" }
    });
    expect(vi.mocked(updateCustomerOwnerFields)).not.toHaveBeenCalled();
    expect(vi.mocked(summarizeCustomerMemoryAndLog)).not.toHaveBeenCalled();
  });

  it("customer surfaces (sms/voice) still NEVER overwrite an existing name", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      memory({ display_name: "Juhu", name_source: "manual" })
    );

    const result = await setCustomerDisplayName(BIZ, PHONE, "Muhammad Fahad Juhu", "sms");

    expect(result).toEqual({
      ok: true,
      data: { updated: false, reason: "name_already_set" }
    });
    expect(vi.mocked(updateCustomerOwnerFields)).not.toHaveBeenCalled();
    expect(vi.mocked(summarizeCustomerMemoryAndLog)).not.toHaveBeenCalled();
  });

  it("fill path (empty display_name) stays agent-provenance: no name_source stamp, no re-summarize", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ display_name: null }));
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);

    const result = await setCustomerDisplayName(BIZ, PHONE, "Joe", "dashboard");

    expect(result).toEqual({ ok: true, data: { updated: true } });
    expect(vi.mocked(updateCustomerOwnerFields)).toHaveBeenCalledWith(BIZ, PHONE, {
      displayName: "Joe"
    });
    expect(vi.mocked(summarizeCustomerMemoryAndLog)).not.toHaveBeenCalled();
  });
});

describe("appendCustomerPinnedNote", () => {
  it("refuses a single note that alone exceeds the pinned_md cap", async () => {
    const result = await appendCustomerPinnedNote(
      BIZ,
      "+15551230000",
      "x".repeat(PINNED_MAX_CHARS),
      "sms",
      "chat"
    );
    expect(result).toEqual({ ok: false, detail: "note_too_long" });
    expect(vi.mocked(updateCustomerOwnerFields)).not.toHaveBeenCalled();
  });
});
