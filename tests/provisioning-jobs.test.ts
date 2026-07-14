import { beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = { data?: unknown; error?: { message: string } | null };

/** Chainable + thenable PostgREST builder stub (tests/webchat-db pattern). */
function makeBuilder(result: StubResult) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "update", "upsert", "insert", "order", "limit"]) {
    b[m] = vi.fn(() => b);
  }
  b.maybeSingle = vi.fn(async () => result);
  b.then = (resolve: (v: StubResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return b;
}

const supabaseStub = { from: vi.fn(), rpc: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseStub)
}));

import {
  claimStalledProvisioningJob,
  enqueueProvisioningJob,
  heartbeatProvisioningJob,
  markProvisioningJobOutcome,
  markProvisioningJobRunning,
  retryStalledProvisioningJob,
  runProvisioningJob,
  PROVISIONING_STALE_AFTER_MS,
  type ProvisioningJobRow
} from "@/lib/provisioning/jobs";

const BIZ = "11111111-1111-4111-8111-111111111111";

const JOB_ROW: ProvisioningJobRow = {
  business_id: BIZ,
  status: "running",
  attempts: 2,
  max_attempts: 3,
  tier: "standard",
  vps_size: "kvm2",
  billing_period: "monthly",
  last_error: null,
  enqueued_at: "2026-07-14T18:00:00Z",
  started_at: "2026-07-14T18:00:05Z",
  heartbeat_at: "2026-07-14T18:01:00Z",
  completed_at: null,
  updated_at: "2026-07-14T18:01:00Z"
};

const injected = supabaseStub as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enqueueProvisioningJob", () => {
  it("upserts a fresh queued row keyed on business_id", async () => {
    const builder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await enqueueProvisioningJob({
      businessId: BIZ,
      tier: "standard",
      vpsSize: null,
      billingPeriod: "monthly"
    });
    const [payload, opts] = (builder.upsert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toMatchObject({
      business_id: BIZ,
      status: "queued",
      attempts: 0,
      tier: "standard",
      vps_size: null,
      billing_period: "monthly",
      started_at: null,
      heartbeat_at: null,
      completed_at: null
    });
    expect(opts).toEqual({ onConflict: "business_id" });
  });

  it("throws on upsert error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ error: { message: "x" } }));
    await expect(
      enqueueProvisioningJob(
        { businessId: BIZ, tier: null, vpsSize: null, billingPeriod: null },
        injected
      )
    ).rejects.toThrow("enqueueProvisioningJob: x");
  });
});

describe("markProvisioningJobRunning", () => {
  it("flips to running with attempts+1 from the stored row", async () => {
    supabaseStub.from
      .mockReturnValueOnce(makeBuilder({ data: { attempts: 1 }, error: null }))
      .mockReturnValueOnce(makeBuilder({ error: null }));
    await markProvisioningJobRunning(BIZ);
    const update = (supabaseStub.from.mock.results[1].value.update as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(update).toMatchObject({ status: "running", attempts: 2 });
    expect(typeof update.heartbeat_at).toBe("string");
  });

  it("defaults attempts to 1 when no row exists yet, surfaces read/update errors", async () => {
    supabaseStub.from
      .mockReturnValueOnce(makeBuilder({ data: null, error: null }))
      .mockReturnValueOnce(makeBuilder({ error: null }));
    await markProvisioningJobRunning(BIZ, injected);
    const update = (supabaseStub.from.mock.results[1].value.update as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(update.attempts).toBe(1);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "r" } }));
    await expect(markProvisioningJobRunning(BIZ)).rejects.toThrow(
      "markProvisioningJobRunning: r"
    );

    supabaseStub.from
      .mockReturnValueOnce(makeBuilder({ data: { attempts: 0 }, error: null }))
      .mockReturnValueOnce(makeBuilder({ error: { message: "u" } }));
    await expect(markProvisioningJobRunning(BIZ)).rejects.toThrow(
      "markProvisioningJobRunning: u"
    );
  });
});

describe("markProvisioningJobOutcome", () => {
  it("stamps the terminal status, bounding last_error", async () => {
    const builder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await markProvisioningJobOutcome(BIZ, "failed", "e".repeat(2000));
    const update = (builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(update.status).toBe("failed");
    expect((update.last_error as string).length).toBe(1000);
    expect(typeof update.completed_at).toBe("string");
  });

  it("nulls last_error on success, throws on error", async () => {
    const builder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await markProvisioningJobOutcome(BIZ, "succeeded", undefined, injected);
    expect((builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0].last_error).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ error: { message: "x" } }));
    await expect(markProvisioningJobOutcome(BIZ, "succeeded")).rejects.toThrow(
      "markProvisioningJobOutcome: x"
    );
  });
});

describe("heartbeatProvisioningJob", () => {
  it("bumps heartbeat on running rows only", async () => {
    const builder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await heartbeatProvisioningJob(BIZ);
    expect(builder.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(builder.eq).toHaveBeenCalledWith("status", "running");
  });

  it("swallows failures — a heartbeat must never fail a progress write", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ error: { message: "down" } }));
    await expect(heartbeatProvisioningJob(BIZ, injected)).resolves.toBeUndefined();

    // Non-Error throw shapes are swallowed too.
    supabaseStub.from.mockImplementationOnce(() => {
      throw "plain string";
    });
    await expect(heartbeatProvisioningJob(BIZ)).resolves.toBeUndefined();
  });
});

describe("claimStalledProvisioningJob", () => {
  it("returns the claimed row / null when nothing is stalled / throws on error", async () => {
    supabaseStub.rpc.mockResolvedValueOnce({ data: [JOB_ROW], error: null });
    expect(await claimStalledProvisioningJob()).toEqual(JOB_ROW);
    expect(supabaseStub.rpc).toHaveBeenCalledWith("claim_stalled_provisioning_job", {
      p_stale_ms: PROVISIONING_STALE_AFTER_MS
    });

    supabaseStub.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await claimStalledProvisioningJob(60_000, injected)).toBeNull();

    supabaseStub.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await claimStalledProvisioningJob()).toBeNull();

    supabaseStub.rpc.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    await expect(claimStalledProvisioningJob()).rejects.toThrow(
      "claimStalledProvisioningJob: x"
    );
  });
});

describe("runProvisioningJob", () => {
  const okResult = { hostingerBillingSubscriptionId: "hsub-1" };

  it("marks running → orchestrates → marks succeeded", async () => {
    const markRunning = vi.fn(async () => undefined);
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    const out = await runProvisioningJob(JOB_ROW, { orchestrate, markRunning, markOutcome });
    expect(out).toEqual(okResult);
    expect(markRunning).toHaveBeenCalledWith(BIZ);
    expect(orchestrate).toHaveBeenCalledWith({
      businessId: BIZ,
      tier: "standard",
      vpsSize: "kvm2",
      billingPeriod: "monthly"
    });
    expect(markOutcome).toHaveBeenCalledWith(BIZ, "succeeded");
  });

  it("narrows unknown tier/billing snapshots defensively", async () => {
    const orchestrate = vi.fn(async () => okResult);
    await runProvisioningJob(
      { business_id: BIZ, tier: "corrupt", vps_size: null, billing_period: "weekly" },
      { orchestrate, markRunning: vi.fn(async () => undefined), markOutcome: vi.fn(async () => undefined) }
    );
    expect(orchestrate).toHaveBeenCalledWith({
      businessId: BIZ,
      tier: "standard",
      vpsSize: null,
      billingPeriod: null
    });

    await runProvisioningJob(
      { business_id: BIZ, tier: "enterprise", vps_size: "kvm8", billing_period: "biennial" },
      { orchestrate, markRunning: vi.fn(async () => undefined), markOutcome: vi.fn(async () => undefined) }
    );
    expect(orchestrate).toHaveBeenLastCalledWith({
      businessId: BIZ,
      tier: "enterprise",
      vpsSize: "kvm8",
      billingPeriod: "biennial"
    });
  });

  it("falls back to the real outcome marker when deps omit it", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ error: null }));
    const out = await runProvisioningJob(
      JOB_ROW,
      { orchestrate: vi.fn(async () => okResult), markRunning: vi.fn(async () => undefined) },
      { alreadyClaimed: false }
    );
    expect(out).toEqual(okResult);
    expect(supabaseStub.from).toHaveBeenCalledWith("provisioning_jobs");
  });

  it("skips the running mark when the watchdog already claimed", async () => {
    const markRunning = vi.fn(async () => undefined);
    await runProvisioningJob(
      JOB_ROW,
      { orchestrate: vi.fn(async () => okResult), markRunning, markOutcome: vi.fn(async () => undefined) },
      { alreadyClaimed: true }
    );
    expect(markRunning).not.toHaveBeenCalled();
  });

  it("records the failure and rethrows the orchestrator error", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => {
      throw new Error("Hostinger 402");
    });
    await expect(
      runProvisioningJob(JOB_ROW, {
        orchestrate,
        markRunning: vi.fn(async () => undefined),
        markOutcome
      })
    ).rejects.toThrow("Hostinger 402");
    expect(markOutcome).toHaveBeenCalledWith(BIZ, "failed", "Hostinger 402");
  });

  it("treats every ledger write as best-effort (marker failures never break the provision)", async () => {
    const failingError = vi.fn(async () => {
      throw new Error("ledger down");
    });
    const failingString = vi.fn(async () => {
      throw "ledger string down";
    });

    // Success path with Error-shaped marker failures…
    const out = await runProvisioningJob(JOB_ROW, {
      orchestrate: vi.fn(async () => okResult),
      markRunning: failingError,
      markOutcome: failingError
    });
    expect(out).toEqual(okResult);

    // …and with non-Error throw shapes (libraries throwing strings).
    const out2 = await runProvisioningJob(JOB_ROW, {
      orchestrate: vi.fn(async () => okResult),
      markRunning: failingString,
      markOutcome: failingString
    });
    expect(out2).toEqual(okResult);

    // Failure path: outcome marker down (Error) + non-Error orchestrator throw.
    await expect(
      runProvisioningJob(JOB_ROW, {
        orchestrate: vi.fn(async () => {
          throw "string failure";
        }),
        markRunning: vi.fn(async () => undefined),
        markOutcome: failingError
      })
    ).rejects.toBe("string failure");

    // Failure path with a string-shaped outcome-marker failure.
    await expect(
      runProvisioningJob(JOB_ROW, {
        orchestrate: vi.fn(async () => {
          throw new Error("orchestrate down");
        }),
        markRunning: vi.fn(async () => undefined),
        markOutcome: failingString
      })
    ).rejects.toThrow("orchestrate down");
  });
});

describe("retryStalledProvisioningJob", () => {
  const okResult = { hostingerBillingSubscriptionId: null };

  it("is idle when nothing is stalled", async () => {
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => null),
      getBusinessStatus: vi.fn(async () => "offline"),
      orchestrate: vi.fn(async () => okResult)
    });
    expect(result).toEqual({ kind: "idle" });
  });

  it.each(["online", "high_load"] as const)(
    "settles a stale job to succeeded when the business is already %s (manual recovery / finished run)",
    async (status) => {
      const markOutcome = vi.fn(async () => undefined);
      const orchestrate = vi.fn(async () => okResult);
      const result = await retryStalledProvisioningJob({
        claim: vi.fn(async () => JOB_ROW),
        getBusinessStatus: vi.fn(async () => status),
        orchestrate,
        markOutcome
      });
      expect(result).toEqual({ kind: "already_online", businessId: BIZ });
      expect(orchestrate).not.toHaveBeenCalled();
      expect(markOutcome).toHaveBeenCalledWith(BIZ, "succeeded");
    }
  );

  it("tolerates a settle failure on the already-online path (Error and string shapes)", async () => {
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => JOB_ROW),
      getBusinessStatus: vi.fn(async () => "online"),
      orchestrate: vi.fn(async () => okResult),
      markOutcome: vi.fn(async () => {
        throw new Error("settle down");
      })
    });
    expect(result.kind).toBe("already_online");

    const result2 = await retryStalledProvisioningJob({
      claim: vi.fn(async () => JOB_ROW),
      getBusinessStatus: vi.fn(async () => "online"),
      orchestrate: vi.fn(async () => okResult),
      markOutcome: vi.fn(async () => {
        throw "settle string down";
      })
    });
    expect(result2.kind).toBe("already_online");
  });

  it("re-runs the orchestrator for a genuinely dead job", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => JOB_ROW),
      getBusinessStatus: vi.fn(async () => "offline"),
      orchestrate,
      markOutcome
    });
    expect(result).toEqual({ kind: "retried", businessId: BIZ, attempts: 2 });
    expect(orchestrate).toHaveBeenCalled();
    expect(markOutcome).toHaveBeenCalledWith(BIZ, "succeeded");
  });

  it("reports a failed retry (attempts already bumped by the claim)", async () => {
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => JOB_ROW),
      getBusinessStatus: vi.fn(async () => null),
      orchestrate: vi.fn(async () => {
        throw new Error("still broken");
      }),
      markOutcome: vi.fn(async () => undefined)
    });
    expect(result).toEqual({
      kind: "retry_failed",
      businessId: BIZ,
      attempts: 2,
      error: "still broken"
    });
  });

  it("stringifies non-Error retry failures", async () => {
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => JOB_ROW),
      getBusinessStatus: vi.fn(async () => "offline"),
      orchestrate: vi.fn(async () => {
        throw "plain failure";
      }),
      markOutcome: vi.fn(async () => undefined)
    });
    expect(result).toMatchObject({ kind: "retry_failed", error: "plain failure" });
  });
});
