import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  DATA_RESIDENCY_MODES,
  RESIDENCY_TIER_MESSAGE,
  ResidencyValidationError,
  assertResidencyModeAllowed,
  isDataResidencyMode,
  residencyAllowedForTier
} from "@/lib/residency/tier-gate";
import {
  RESIDENCY_MOVED_TABLES,
  isResidencyMovedTable
} from "@/lib/residency/tables";
import { dataApiHostname } from "@/lib/residency/contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

/** Minimal from().select().eq().maybeSingle() chain returning a fixed result. */
function tierDb(result: { data?: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { db: { from } as never, from, select, eq };
}

describe("residency tier gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only the enterprise tier can carry residency", () => {
    expect(residencyAllowedForTier("enterprise")).toBe(true);
    expect(residencyAllowedForTier("standard")).toBe(false);
    expect(residencyAllowedForTier("starter")).toBe(false);
    expect(residencyAllowedForTier(null)).toBe(false);
    expect(residencyAllowedForTier(undefined)).toBe(false);
  });

  it("narrows modes and lists exactly the three rollout states", () => {
    expect(DATA_RESIDENCY_MODES).toEqual(["supabase", "dual", "vps"]);
    for (const m of DATA_RESIDENCY_MODES) expect(isDataResidencyMode(m)).toBe(true);
    expect(isDataResidencyMode("purged")).toBe(false);
    expect(isDataResidencyMode(null)).toBe(false);
  });

  it("allows forward modes for enterprise businesses (explicit client)", async () => {
    const { db, from, eq } = tierDb({ data: { tier: "enterprise" }, error: null });
    await expect(assertResidencyModeAllowed(BIZ, "dual", db)).resolves.toBeUndefined();
    await expect(assertResidencyModeAllowed(BIZ, "vps", db)).resolves.toBeUndefined();
    expect(from).toHaveBeenCalledWith("businesses");
    expect(eq).toHaveBeenCalledWith("id", BIZ);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("rejects forward modes for non-enterprise tiers with the upgrade message", async () => {
    const { db } = tierDb({ data: { tier: "standard" }, error: null });
    await expect(assertResidencyModeAllowed(BIZ, "dual", db)).rejects.toBeInstanceOf(
      ResidencyValidationError
    );
    await expect(assertResidencyModeAllowed(BIZ, "vps", db)).rejects.toThrow(
      RESIDENCY_TIER_MESSAGE
    );
  });

  it("rejects when the business row is missing", async () => {
    const { db } = tierDb({ data: null, error: null });
    await expect(assertResidencyModeAllowed(BIZ, "vps", db)).rejects.toThrow(
      RESIDENCY_TIER_MESSAGE
    );
  });

  it("surfaces query errors as plain errors (500, not an upsell)", async () => {
    const { db } = tierDb({ data: null, error: { message: "db down" } });
    const err = await assertResidencyModeAllowed(BIZ, "vps", db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ResidencyValidationError);
    expect((err as Error).message).toContain("db down");
  });

  it("always allows flipping back to the supabase default (no DB read)", async () => {
    // A downgraded tenant must never be wedged in a residency mode its plan
    // no longer supports — the rollback path skips the tier lookup entirely.
    const { db, from } = tierDb({ data: { tier: "starter" }, error: null });
    await expect(assertResidencyModeAllowed(BIZ, "supabase", db)).resolves.toBeUndefined();
    expect(from).not.toHaveBeenCalled();
  });

  it("falls back to the service client when none is provided", async () => {
    const { db } = tierDb({ data: { tier: "enterprise" }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db);
    await expect(assertResidencyModeAllowed(BIZ, "vps")).resolves.toBeUndefined();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("residency moved-table inventory", () => {
  it("keeps the compliance, engine, and control-plane tables central", () => {
    // sms_opt_outs gates STOP handling on the webhook path; engine/job
    // tables are drained by Edge workers; customer_profiles is the
    // platform's abuse/billing identity of the OWNER (not tenant content);
    // customer_memories and contact_overrides no longer exist as tables
    // (contacts_unify merged them into contacts — the former survives only
    // as a compat view, which is not replicated).
    for (const central of [
      "sms_opt_outs",
      "ai_flow_runs",
      "sms_inbound_jobs",
      "dashboard_chat_jobs",
      "telnyx_webhook_events",
      "businesses",
      "subscriptions",
      "vps_gateway_tokens",
      "customer_profiles",
      "customer_memories",
      "contact_overrides"
    ]) {
      expect(isResidencyMovedTable(central)).toBe(false);
    }
  });

  it("moves the tenant-content tables", () => {
    for (const moved of [
      "contacts",
      "dashboard_chat_messages",
      "email_log",
      "voice_call_transcript_turns",
      "sms_outbound_log",
      "notifications",
      "ai_flows"
    ]) {
      expect(isResidencyMovedTable(moved)).toBe(true);
    }
    // No duplicates.
    expect(new Set(RESIDENCY_MOVED_TABLES).size).toBe(RESIDENCY_MOVED_TABLES.length);
  });
});

describe("data-api contract helpers", () => {
  it("builds the data- prefixed tunnel hostname", () => {
    expect(dataApiHostname("biz-uuid", "newcoworker.com")).toBe(
      "data-biz-uuid.newcoworker.com"
    );
  });
});
