import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import { resolveStaffCaller } from "@/lib/voice-tools/staff-caller";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * The server-side half of the voice flow-tool gate. The bridge withholds the
 * tool declaration from customer callers; this resolver is the check that does
 * not depend on the box, and it fails CLOSED: only a number the platform can
 * PROVE belongs to the owner or an active roster member is staff.
 */

const BIZ = "biz-1";

type Rows = {
  business?: { owner_name?: string | null; phone?: string | null } | null;
  telnyx?: { forward_to_e164?: string | null } | null;
  prefs?: { phone_number?: string | null } | null;
  team?: Array<{ name?: string | null; phone_e164?: string | null }>;
  error?: string;
};

function mockDb(rows: Rows) {
  const client = {
    from(table: string) {
      const err = rows.error ? { message: rows.error } : null;
      if (table === "ai_flow_team_members") {
        // `?? null` (not `[]`): PostgREST can answer a null body, which the
        // resolver must tolerate.
        return {
          select: () => ({
            eq: () => ({ eq: async () => ({ data: rows.team ?? null, error: err }) })
          })
        };
      }
      const single = async () => {
        if (table === "businesses") return { data: rows.business ?? null, error: err };
        if (table === "business_telnyx_settings") return { data: rows.telnyx ?? null, error: err };
        return { data: rows.prefs ?? null, error: err };
      };
      return { select: () => ({ eq: () => ({ maybeSingle: single }) }) };
    }
  };
  vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
}

describe("resolveStaffCaller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recognizes the owner by the onboarding phone, forward cell, or alert phone", async () => {
    for (const rows of [
      { business: { owner_name: "Amy", phone: "+16025551212" } },
      { business: { owner_name: "Amy" }, telnyx: { forward_to_e164: "+16025551212" } },
      { business: { owner_name: "Amy" }, prefs: { phone_number: "+16025551212" } }
    ]) {
      mockDb(rows);
      await expect(resolveStaffCaller(BIZ, "+16025551212")).resolves.toEqual({
        kind: "owner",
        name: "Amy"
      });
    }
  });

  it("normalizes a loosely formatted caller id", async () => {
    mockDb({ business: { owner_name: "Amy", phone: "+16025551212" } });
    await expect(resolveStaffCaller(BIZ, "(602) 555-1212")).resolves.toMatchObject({
      kind: "owner"
    });
  });

  it("recognizes an active roster member", async () => {
    mockDb({ team: [{ name: "Gabrielle Mota", phone_e164: "+14807202013" }] });
    await expect(resolveStaffCaller(BIZ, "+14807202013")).resolves.toEqual({
      kind: "team",
      name: "Gabrielle Mota"
    });
  });

  it("gives the owner precedence when a number is both", async () => {
    mockDb({
      business: { owner_name: "Amy", phone: "+16025551212" },
      team: [{ name: "Amy Laidlaw", phone_e164: "+16025551212" }]
    });
    await expect(resolveStaffCaller(BIZ, "+16025551212")).resolves.toMatchObject({
      kind: "owner"
    });
  });

  it("leaves the name null rather than inventing one", async () => {
    mockDb({ business: { owner_name: "  ", phone: "+16025551212" } });
    await expect(resolveStaffCaller(BIZ, "+16025551212")).resolves.toEqual({
      kind: "owner",
      name: null
    });
    // Same for a nameless roster row, and a roster row with no phone at all is
    // simply skipped rather than matching an empty caller.
    mockDb({ team: [{ phone_e164: null }, { name: "   ", phone_e164: "+14807202013" }] });
    await expect(resolveStaffCaller(BIZ, "+14807202013")).resolves.toEqual({
      kind: "team",
      name: null
    });
  });

  it("handles a null roster body", async () => {
    mockDb({ business: { phone: "+16025551212" }, team: undefined });
    await expect(resolveStaffCaller(BIZ, "+14807202013")).resolves.toBeNull();
  });

  it("a stranger, a blank caller id, and an unknown number are all NOT staff", async () => {
    mockDb({ business: { phone: "+16025551212" }, team: [{ phone_e164: "+14807202013" }] });
    await expect(resolveStaffCaller(BIZ, "+14155550000")).resolves.toBeNull();
    await expect(resolveStaffCaller(BIZ, "")).resolves.toBeNull();
    await expect(resolveStaffCaller(BIZ, null)).resolves.toBeNull();
    await expect(resolveStaffCaller(BIZ, undefined)).resolves.toBeNull();
  });

  it("fails CLOSED on a read error (a blip must not authorize a stranger)", async () => {
    mockDb({ business: { phone: "+16025551212" }, error: "db down" });
    await expect(resolveStaffCaller(BIZ, "+16025551212")).resolves.toBeNull();
  });

  it("fails CLOSED when the client cannot be created, Error or not", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no client"));
    await expect(resolveStaffCaller(BIZ, "+16025551212")).resolves.toBeNull();
    vi.mocked(createSupabaseServiceClient).mockRejectedValue("plain string throw");
    await expect(resolveStaffCaller(BIZ, "+16025551212")).resolves.toBeNull();
  });
});
