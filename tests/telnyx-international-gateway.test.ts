import { describe, expect, it, vi } from "vitest";
import {
  isInternationalSmsDestination,
  internationalGatewayFrom,
  INTERNATIONAL_MMS_ERROR
} from "@/lib/telnyx/international-gateway";
import {
  internationalGatewayFrom as edgeGatewayFrom,
  partitionInternationalSmsRecipients,
  resolveGatewayInboundBusiness,
  resolveInternationalFrom
} from "../supabase/functions/_shared/sms_international_gateway";

describe("isInternationalSmsDestination", () => {
  it("treats US and CA as domestic, everything else (and unknown) as international", () => {
    expect(isInternationalSmsDestination("US")).toBe(false);
    expect(isInternationalSmsDestination("CA")).toBe(false);
    expect(isInternationalSmsDestination("HK")).toBe(true);
    expect(isInternationalSmsDestination("GB")).toBe(true);
    // Caribbean NANP territories are separate countries with their own
    // routing: international for gateway purposes.
    expect(isInternationalSmsDestination("JM")).toBe(true);
    // Unresolvable country: the destination gate refuses these anyway, but
    // the router must not classify them as domestic.
    expect(isInternationalSmsDestination(null)).toBe(true);
  });
});

describe("internationalGatewayFrom", () => {
  it("returns the configured E.164 and null when unset/blank", () => {
    expect(internationalGatewayFrom({ TELNYX_INTL_GATEWAY_E164: "+16028384497" })).toBe(
      "+16028384497"
    );
    expect(internationalGatewayFrom({ TELNYX_INTL_GATEWAY_E164: "  " })).toBeNull();
    expect(internationalGatewayFrom({})).toBeNull();
  });

  it("edge lockstep copy agrees", () => {
    expect(edgeGatewayFrom({ TELNYX_INTL_GATEWAY_E164: "+16028384497" })).toBe("+16028384497");
    expect(edgeGatewayFrom({})).toBeNull();
  });

  it("edge copy reads Deno.env when running under Deno", () => {
    const g = globalThis as { Deno?: { env: { get: (n: string) => string | undefined } } };
    g.Deno = { env: { get: (n) => (n === "TELNYX_INTL_GATEWAY_E164" ? "+16028384497" : undefined) } };
    try {
      expect(edgeGatewayFrom()).toBe("+16028384497");
    } finally {
      delete g.Deno;
    }
  });

  it("exports a stable user-facing MMS refusal message", () => {
    expect(INTERNATIONAL_MMS_ERROR).toMatch(/[Pp]icture/);
  });
});

describe("partitionInternationalSmsRecipients", () => {
  it("splits domestic from international recipients", () => {
    const { domestic, international } = partitionInternationalSmsRecipients([
      "+16025550100",
      "+85261234567",
      "+15145188192",
      "+447911123456"
    ]);
    expect(domestic).toEqual(["+16025550100", "+15145188192"]);
    expect(international).toEqual(["+85261234567", "+447911123456"]);
  });

  it("treats unresolvable numbers as international (never silently grouped)", () => {
    const { domestic, international } = partitionInternationalSmsRecipients(["bogus"]);
    expect(domestic).toEqual([]);
    expect(international).toEqual(["bogus"]);
  });
});

type Row = { data: unknown; error: { message: string } | null };

/**
 * Structural fake for the resolver: each table returns its configured row
 * for a maybeSingle() chain, and sms_outbound_log supports the
 * order().limit() list shape.
 */
function fakeSupabase(rows: {
  forwardMatch?: string | null;
  prefsMatch?: string | null;
  bizMatch?: string | null;
  recentLogBusiness?: string | null;
  logDataNull?: boolean;
}) {
  const from = vi.fn((table: string) => {
    const single: Row =
      table === "business_telnyx_settings"
        ? { data: rows.forwardMatch ? { business_id: rows.forwardMatch } : null, error: null }
        : table === "notification_preferences"
          ? { data: rows.prefsMatch ? { business_id: rows.prefsMatch } : null, error: null }
          : { data: rows.bizMatch ? { id: rows.bizMatch } : null, error: null };
    const list: Row = {
      data: rows.logDataNull ? null : rows.recentLogBusiness ? [{ business_id: rows.recentLogBusiness }] : [],
      error: null
    };
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(list));
    chain.maybeSingle = vi.fn(() => Promise.resolve(single));
    return chain;
  });
  return { from };
}

describe("resolveGatewayInboundBusiness", () => {
  it("matches an owner forwarding number first", async () => {
    const db = fakeSupabase({ forwardMatch: "biz-forward" });
    const res = await resolveGatewayInboundBusiness(db as never, "+85261234567");
    expect(res).toEqual({ businessId: "biz-forward", matchedBy: "forward_to_e164" });
  });

  it("falls through owner columns in order: forward, alert phone, business phone", async () => {
    const prefs = fakeSupabase({ prefsMatch: "biz-prefs" });
    expect(await resolveGatewayInboundBusiness(prefs as never, "+85261234567")).toEqual({
      businessId: "biz-prefs",
      matchedBy: "notification_phone"
    });
    const biz = fakeSupabase({ bizMatch: "biz-owner" });
    expect(await resolveGatewayInboundBusiness(biz as never, "+85261234567")).toEqual({
      businessId: "biz-owner",
      matchedBy: "business_phone"
    });
  });

  it("falls back to the most recent outbound conversation", async () => {
    const db = fakeSupabase({ recentLogBusiness: "biz-convo" });
    expect(await resolveGatewayInboundBusiness(db as never, "+85261234567")).toEqual({
      businessId: "biz-convo",
      matchedBy: "recent_outbound"
    });
  });

  it("returns null when nothing matches (caller parks + alerts ops)", async () => {
    const db = fakeSupabase({});
    expect(await resolveGatewayInboundBusiness(db as never, "+85261234567")).toBeNull();
    // A null log payload (not just an empty list) parks identically.
    const nullLog = fakeSupabase({ logDataNull: true });
    expect(await resolveGatewayInboundBusiness(nullLog as never, "+85261234567")).toBeNull();
  });
});

describe("resolveInternationalFrom", () => {
  it("substitutes the gateway for international, keeps tenant from domestically", () => {
    const env = { TELNYX_INTL_GATEWAY_E164: "+16028384497" };
    expect(resolveInternationalFrom("+85261234567", "+14388035806", env)).toBe("+16028384497");
    expect(resolveInternationalFrom("+16025550100", "+14388035806", env)).toBe("+14388035806");
  });

  it("keeps the tenant from-number when no gateway is configured", () => {
    expect(resolveInternationalFrom("+85261234567", "+14388035806", {})).toBe("+14388035806");
    expect(resolveInternationalFrom("+85261234567", null, {})).toBeNull();
    expect(resolveInternationalFrom("+16025550100", undefined, {})).toBeNull();
  });
});
