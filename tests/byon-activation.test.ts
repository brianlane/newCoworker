import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/telnyx/assign-did", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telnyx/assign-did")>();
  return { ...actual, assignExistingDidToBusiness: vi.fn() };
});

vi.mock("@/lib/provisioning/tendlc-attach", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provisioning/tendlc-attach")>();
  return { ...actual, attachBusinessDidToCampaign: vi.fn() };
});

vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchUrgentNotification: vi.fn()
}));

vi.mock("@/lib/telnyx/numbers", () => ({
  // Regular function so `new TelnyxNumbersClient(...)` works (arrows can't
  // be constructed).
  TelnyxNumbersClient: vi.fn(function TelnyxNumbersClient() {
    return { tag: "numbers-client" };
  })
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { activatePortedNumber, type PortedNumberRow } from "@/lib/byon/activation";
import { assignExistingDidToBusiness } from "@/lib/telnyx/assign-did";
import { attachBusinessDidToCampaign } from "@/lib/provisioning/tendlc-attach";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";
import { logger } from "@/lib/logger";

const assignMock = vi.mocked(assignExistingDidToBusiness);
const attachMock = vi.mocked(attachBusinessDidToCampaign);
const dispatchMock = vi.mocked(dispatchUrgentNotification);
const defaultClientMock = vi.mocked(createSupabaseServiceClient);

const ROW: PortedNumberRow = {
  id: "req-1",
  business_id: "biz-1",
  phone_e164: "+13125550001",
  telnyx_order_id: "po-1",
  status: "ported",
  activated_at: null,
  activation_error: null
};

type DbCall = { name: string; args: unknown[] };
type DbResult = { data?: unknown; error: { message: string } | null };

/**
 * Minimal thenable builder for the activation_error claim and activated_at
 * stamp updates. Results are consumed per from() call; when exhausted, a
 * "matched one row" default keeps unrelated tests simple.
 */
function actDb(results: DbResult[] = []) {
  const calls: DbCall[][] = [];
  let i = 0;
  const from = (table: string) => {
    const my: DbCall[] = [{ name: "from", args: [table] }];
    calls.push(my);
    const result = results[i++] ?? { data: [{}], error: null };
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    };
    for (const m of ["update", "eq", "is", "select"]) {
      builder[m] = (...args: unknown[]) => {
        my.push({ name: m, args });
        return builder;
      };
    }
    return builder;
  };
  return { db: { from } as never, calls };
}

const ENV = {
  TELNYX_API_KEY: "key",
  TELNYX_CONNECTION_ID: "conn-1",
  TELNYX_MESSAGING_PROFILE_ID: "mp-1",
  BRIDGE_MEDIA_WSS_ORIGIN: "wss://bridge.example"
};

const ASSIGN_RESULT = {
  route: { to_e164: "+13125550001" },
  settings: { business_id: "biz-1" }
} as never;

describe("activatePortedNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignMock.mockResolvedValue(ASSIGN_RESULT);
    attachMock.mockResolvedValue({ kind: "registered", campaignId: "c-1" });
    dispatchMock.mockResolvedValue({ results: [] });
    defaultClientMock.mockResolvedValue(actDb().db);
  });

  it("skips rows that are not ported or already activated", async () => {
    const notPorted = await activatePortedNumber(
      { ...ROW, status: "foc-date-confirmed" },
      { env: ENV }
    );
    expect(notPorted).toEqual({
      attempted: false,
      activated: false,
      assign: null,
      tendlc: null,
      error: null
    });

    const settled = await activatePortedNumber(
      { ...ROW, activated_at: "2026-07-01T00:00:00Z" },
      { env: ENV }
    );
    expect(settled.attempted).toBe(false);

    expect(assignMock).not.toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("wires voice routes and 10DLC for the ported number using platform defaults", async () => {
    const { db, calls } = actDb();
    const result = await activatePortedNumber(ROW, { env: ENV, client: db });

    expect(result).toEqual({
      attempted: true,
      activated: true,
      assign: ASSIGN_RESULT,
      tendlc: { kind: "registered", campaignId: "c-1" },
      error: null
    });
    // activated_at stamped conditionally (clearing any recorded failure) so
    // redeliveries skip the wiring.
    const stamp = calls[0];
    expect(stamp.find((c) => c.name === "update")?.args[0]).toMatchObject({
      activated_at: expect.any(String),
      activation_error: null
    });
    expect(stamp).toContainEqual({ name: "eq", args: ["id", "req-1"] });
    expect(stamp).toContainEqual({ name: "is", args: ["activated_at", null] });
    expect(assignMock).toHaveBeenCalledWith(
      {
        businessId: "biz-1",
        toE164: "+13125550001",
        platformDefaults: {
          connectionId: "conn-1",
          messagingProfileId: "mp-1",
          bridgeMediaWssOrigin: "wss://bridge.example"
        },
        associateWithPlatform: true
      },
      { telnyxNumbers: expect.objectContaining({ tag: "numbers-client" }) }
    );
    expect(TelnyxNumbersClient).toHaveBeenCalledWith({ apiKey: "key" });
    expect(attachMock).toHaveBeenCalledWith({ businessId: "biz-1", toE164: "+13125550001" });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "byon: ported number activated",
      expect.objectContaining({ portRequestId: "req-1", tendlc: "registered" })
    );
  });

  it("uses an injected numbers client and process.env by default", async () => {
    vi.stubEnv("TELNYX_API_KEY", "env-key");
    vi.stubEnv("TELNYX_CONNECTION_ID", "conn-env");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "mp-env");
    try {
      const injected = { tag: "injected" } as never;
      const result = await activatePortedNumber(ROW, { numbersClient: injected });
      expect(result.activated).toBe(true);
      expect(TelnyxNumbersClient).not.toHaveBeenCalled();
      expect(assignMock).toHaveBeenCalledWith(
        expect.objectContaining({
          platformDefaults: expect.objectContaining({ connectionId: "conn-env" })
        }),
        { telnyxNumbers: injected }
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts injected assign/attach/dispatch deps", async () => {
    const assign = vi.fn().mockResolvedValue(ASSIGN_RESULT);
    const attach = vi.fn().mockResolvedValue({ kind: "pending", reason: "campaign_status:PENDING" });
    const dispatch = vi.fn();
    const result = await activatePortedNumber(ROW, {
      env: ENV,
      assign: assign as never,
      attach: attach as never,
      dispatch: dispatch as never
    });
    expect(result.activated).toBe(true);
    expect(result.tendlc).toEqual({ kind: "pending", reason: "campaign_status:PENDING" });
    expect(assign).toHaveBeenCalled();
    expect(attach).toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    // pending is normal right after a port — no warning noise.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails loudly (alerting the owner) when TELNYX_API_KEY is missing", async () => {
    const result = await activatePortedNumber(ROW, { env: { ...ENV, TELNYX_API_KEY: "  " } });
    expect(result).toEqual({
      attempted: true,
      activated: false,
      assign: null,
      tendlc: null,
      error: "TELNYX_API_KEY is not configured"
    });
    expect(assignMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "byon: ported number activation failed",
      expect.objectContaining({ error: "TELNYX_API_KEY is not configured" })
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        kind: "byon_activation",
        payload: expect.objectContaining({
          activation_error: "TELNYX_API_KEY is not configured"
        })
      })
    );
  });

  it("fails when the platform defaults canary trips (blank connection id)", async () => {
    const result = await activatePortedNumber(ROW, {
      env: { ...ENV, TELNYX_CONNECTION_ID: undefined }
    });
    expect(result.activated).toBe(false);
    expect(result.error).toMatch(/connectionId/);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("fails when the assign flow throws, tolerating dispatch failures and non-Error throws", async () => {
    assignMock.mockRejectedValue(new Error("telnyx PATCH exploded"));
    dispatchMock.mockRejectedValue(new Error("smtp down"));
    const result = await activatePortedNumber(ROW, { env: ENV });
    expect(result).toEqual({
      attempted: true,
      activated: false,
      assign: null,
      tendlc: null,
      error: "telnyx PATCH exploded"
    });
    expect(attachMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: activation-failure notification failed",
      expect.objectContaining({ error: "smtp down" })
    );

    assignMock.mockRejectedValue("wat");
    dispatchMock.mockResolvedValue({ results: [] });
    const result2 = await activatePortedNumber(ROW, { env: ENV });
    expect(result2.error).toBe("wat");
  });

  it("alerts the owner exactly once across repeated activation failures", async () => {
    assignMock.mockRejectedValue(new Error("telnyx down"));

    // Row already carries a recorded failure → no claim attempt, no alert.
    const { db: settledDb, calls: settledCalls } = actDb();
    const result = await activatePortedNumber(
      { ...ROW, activation_error: "telnyx down" },
      { env: ENV, client: settledDb }
    );
    expect(result.activated).toBe(false);
    expect(settledCalls).toHaveLength(0); // no DB write at all
    expect(dispatchMock).not.toHaveBeenCalled();

    // Fresh row but a parallel delivery won the claim CAS (or already
    // activated the number, clearing the field) → no alert.
    const { db: lostDb, calls: lostCalls } = actDb([{ data: [], error: null }]);
    await activatePortedNumber(ROW, { env: ENV, client: lostDb });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(lostCalls[0].find((c) => c.name === "update")?.args[0]).toEqual({
      activation_error: "telnyx down"
    });
    expect(lostCalls[0]).toContainEqual({ name: "is", args: ["activation_error", null] });
    // The claim must ALSO require activated_at null: a late failure racing a
    // successful activation must not record an error over live routing.
    expect(lostCalls[0]).toContainEqual({ name: "is", args: ["activated_at", null] });

    // A null no-rows shape also means "someone else claimed".
    await activatePortedNumber(ROW, {
      env: ENV,
      client: actDb([{ data: null, error: null }]).db
    });
    expect(dispatchMock).not.toHaveBeenCalled();

    // Claim write errors → warn and stay quiet (logs carry the failure).
    await activatePortedNumber(ROW, {
      env: ENV,
      client: actDb([{ data: null, error: { message: "claim exploded" } }]).db
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: failed to claim activation-failure alert",
      expect.objectContaining({ error: "claim exploded" })
    );

    // Winning the claim sends the single alert.
    await activatePortedNumber(ROW, { env: ENV, client: actDb([{ data: [{}], error: null }]).db });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("treats 10DLC problems as non-fatal but logs rejected/error outcomes", async () => {
    attachMock.mockResolvedValue({ kind: "rejected", reason: "attach_failed: telnyx_422" });
    const result = await activatePortedNumber(ROW, { env: ENV });
    expect(result.activated).toBe(true);
    expect(result.tendlc).toEqual({ kind: "rejected", reason: "attach_failed: telnyx_422" });
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: 10DLC attach for ported number did not complete",
      expect.objectContaining({ reason: "attach_failed: telnyx_422" })
    );

    // attach throwing (it shouldn't, but belt-and-braces) → error outcome.
    attachMock.mockRejectedValue(new Error("network sneeze"));
    const result2 = await activatePortedNumber(ROW, { env: ENV });
    expect(result2.activated).toBe(true);
    expect(result2.tendlc).toEqual({ kind: "error", reason: "network sneeze" });
  });

  it("treats activated_at stamp failures as non-fatal (error result, thrown, or default client failing)", async () => {
    // Stamp update returns an error → warn, still activated.
    const { db } = actDb([{ error: { message: "stamp exploded" } }]);
    const result = await activatePortedNumber(ROW, { env: ENV, client: db });
    expect(result.activated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: failed to stamp activated_at",
      expect.objectContaining({ error: "stamp exploded" })
    );

    // Default service client construction throwing → warn, still activated.
    defaultClientMock.mockRejectedValue(new Error("no service role key"));
    const result2 = await activatePortedNumber(ROW, { env: ENV });
    expect(result2.activated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: failed to stamp activated_at",
      expect.objectContaining({ error: "no service role key" })
    );
  });
});
