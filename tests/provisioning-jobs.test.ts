import { beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = { data?: unknown; error?: { message: string } | null };

/** Chainable + thenable PostgREST builder stub (tests/webchat-db pattern). */
function makeBuilder(result: StubResult) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "update", "upsert", "insert", "order", "limit"]) {
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
  getLastTermRenewalEnqueuedAt,
  heartbeatProvisioningJob,
  markProvisioningJobOutcome,
  markProvisioningJobRunning,
  retryStalledProvisioningJob,
  runProvisioningJob,
  settleExhaustedProvisioningJobs,
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
  hostinger_term: null,
  suppress_owner_notify: false,
  skip_pool_adopt: false,
  purpose: "signup",
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

describe("getLastTermRenewalEnqueuedAt", () => {
  // enqueued_at is stamped before the Hostinger purchase call, so it is the
  // stamp that survives a term migration which bought a box and then failed.
  it("returns the enqueue time for a term-renewal row", async () => {
    const builder = makeBuilder({
      data: { purpose: "term_renewal", enqueued_at: "2026-07-31T11:01:00Z" },
      error: null
    });
    supabaseStub.from.mockReturnValueOnce(builder);
    await expect(getLastTermRenewalEnqueuedAt(BIZ)).resolves.toEqual(
      new Date("2026-07-31T11:01:00Z")
    );
    expect(supabaseStub.from).toHaveBeenCalledWith("provisioning_jobs");
  });

  // business_id is the primary key and enqueue upserts on conflict, so the row
  // may well be some other purpose by now. That is not a term purchase.
  it("returns null when the current row is a signup", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { purpose: "signup", enqueued_at: "2026-07-31T11:01:00Z" }, error: null })
    );
    await expect(getLastTermRenewalEnqueuedAt(BIZ)).resolves.toBeNull();
  });

  it("returns null when there is no row at all", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    await expect(getLastTermRenewalEnqueuedAt(BIZ)).resolves.toBeNull();
  });

  it("returns null when the row has no enqueued_at", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { purpose: "term_renewal", enqueued_at: null }, error: null })
    );
    await expect(getLastTermRenewalEnqueuedAt(BIZ)).resolves.toBeNull();
  });

  it("returns null when enqueued_at will not parse", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { purpose: "term_renewal", enqueued_at: "nope" }, error: null })
    );
    await expect(getLastTermRenewalEnqueuedAt(BIZ)).resolves.toBeNull();
  });

  it("accepts an injected client and throws on error", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { purpose: "term_renewal", enqueued_at: "2026-07-31T11:01:00Z" }, error: null })
    );
    await expect(getLastTermRenewalEnqueuedAt(BIZ, injected)).resolves.toEqual(
      new Date("2026-07-31T11:01:00Z")
    );

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "boom" } }));
    await expect(getLastTermRenewalEnqueuedAt(BIZ)).rejects.toThrow(
      "getLastEnqueuedAtForPurpose: boom"
    );
  });
});

describe("heartbeatProvisioningJob", () => {
  it("bumps heartbeat on queued AND running rows (queued = markRunning write failed but run is live)", async () => {
    const builder = makeBuilder({ error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await heartbeatProvisioningJob(BIZ);
    expect(builder.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running"]);
  });

  it("swallows failures, a heartbeat must never fail a progress write", async () => {
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
      billingPeriod: "monthly",
      hostingerTerm: null
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
      billingPeriod: null,
      hostingerTerm: null
    });

    await runProvisioningJob(
      { business_id: BIZ, tier: "enterprise", vps_size: "kvm8", billing_period: "biennial" },
      { orchestrate, markRunning: vi.fn(async () => undefined), markOutcome: vi.fn(async () => undefined) }
    );
    expect(orchestrate).toHaveBeenLastCalledWith({
      businessId: BIZ,
      tier: "enterprise",
      vpsSize: "kvm8",
      billingPeriod: "biennial",
      hostingerTerm: null
    });
  });

  // The term is COMPUTED by a sweep and persisted on the row precisely so a
  // later run buys what the sweep decided. Each value Hostinger sells has to
  // survive the round trip; anything else falls back to deriving from
  // billing_period rather than failing the job.
  it("passes each Hostinger term through, and narrows anything else to null", async () => {
    const orchestrate = vi.fn(async () => okResult);
    const markers = {
      markRunning: vi.fn(async () => undefined),
      markOutcome: vi.fn(async () => undefined)
    };

    for (const term of ["1m", "1y", "2y"] as const) {
      await runProvisioningJob({ ...JOB_ROW, hostinger_term: term }, { orchestrate, ...markers });
      expect(orchestrate).toHaveBeenLastCalledWith(
        expect.objectContaining({ hostingerTerm: term })
      );
    }

    for (const bogus of ["3y", "", "monthly"]) {
      await runProvisioningJob(
        { ...JOB_ROW, hostinger_term: bogus },
        { orchestrate, ...markers }
      );
      expect(orchestrate).toHaveBeenLastCalledWith(
        expect.objectContaining({ hostingerTerm: null })
      );
    }
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

describe("settleExhaustedProvisioningJobs", () => {
  it("returns settled business ids / [] / throws on RPC error", async () => {
    supabaseStub.rpc.mockResolvedValueOnce({ data: [JOB_ROW], error: null });
    expect(await settleExhaustedProvisioningJobs()).toEqual([BIZ]);
    expect(supabaseStub.rpc).toHaveBeenCalledWith("settle_exhausted_provisioning_jobs", {
      p_stale_ms: PROVISIONING_STALE_AFTER_MS
    });

    supabaseStub.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await settleExhaustedProvisioningJobs(60_000, injected)).toEqual([]);

    supabaseStub.rpc.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    await expect(settleExhaustedProvisioningJobs()).rejects.toThrow(
      "settleExhaustedProvisioningJobs: x"
    );
  });
});

describe("retryStalledProvisioningJob", () => {
  const okResult = { hostingerBillingSubscriptionId: null };
  const noExhausted = () => vi.fn(async () => [] as string[]);

  it("is idle when nothing is stalled", async () => {
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => null),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "offline"),
      orchestrate: vi.fn(async () => okResult)
    });
    expect(result).toEqual({ kind: "idle" });
  });

  it("flips exhausted zombies to failed and reports them even on an idle tick", async () => {
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => null),
      settleExhausted: vi.fn(async () => ["biz-dead-1", "biz-dead-2"]),
      getBusinessStatus: vi.fn(async () => "offline"),
      orchestrate: vi.fn(async () => okResult)
    });
    expect(result).toEqual({ kind: "idle", exhaustedFailed: ["biz-dead-1", "biz-dead-2"] });
  });

  it("attaches exhausted ids to non-idle outcomes and tolerates settle failures", async () => {
    const retried = await retryStalledProvisioningJob({
      claim: vi.fn(async () => JOB_ROW),
      settleExhausted: vi.fn(async () => ["biz-dead"]),
      getBusinessStatus: vi.fn(async () => "offline"),
      orchestrate: vi.fn(async () => okResult),
      markOutcome: vi.fn(async () => undefined)
    });
    expect(retried).toMatchObject({ kind: "retried", exhaustedFailed: ["biz-dead"] });

    // Settle failures (Error and string shapes) never block the tick.
    for (const boom of [new Error("settle rpc down"), "settle string down"]) {
      const result = await retryStalledProvisioningJob({
        claim: vi.fn(async () => null),
        settleExhausted: vi.fn(async () => {
          throw boom;
        }),
        getBusinessStatus: vi.fn(async () => "offline"),
        orchestrate: vi.fn(async () => okResult)
      });
      expect(result).toEqual({ kind: "idle" });
    }
  });

  it.each(["online", "high_load"] as const)(
    "settles a stale signup job to succeeded when the business is already %s (manual recovery / finished run)",
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

  it("does not settle migration jobs on orchestrator phase complete (cutover still pending)", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    const resumeMigrationDeploy = vi.fn(async () => okResult);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 100,
        phase: "complete",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "success" as const
      })),
      resumeMigrationDeploy,
      orchestrate,
      markOutcome
    });
    expect(result.kind).toBe("retry_failed");
    if (result.kind === "retry_failed") {
      expect(result.error).toMatch(/cutover still pending/);
    }
    expect(orchestrate).not.toHaveBeenCalled();
    expect(resumeMigrationDeploy).not.toHaveBeenCalled();
    expect(markOutcome).toHaveBeenCalledWith(BIZ, "failed", expect.stringContaining("cutover"));
  });

  it("treats high_load + phase complete as cutover-pending too", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "migrate_size",
      suppress_owner_notify: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "high_load"),
      getLatestProgress: vi.fn(async () => ({
        percent: 100,
        phase: "complete",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "success" as const
      })),
      orchestrate: vi.fn(async () => okResult),
      markOutcome
    });
    expect(result.kind).toBe("retry_failed");
  });

  it("falls through to orchestrate when online migration has no progress helper", async () => {
    const orchestrate = vi.fn(async () => okResult);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      orchestrate,
      markOutcome: vi.fn(async () => undefined)
    });
    expect(result.kind).toBe("retried");
    expect(orchestrate).toHaveBeenCalled();
  });

  it("does not settle on deploy_client_complete alone (cutover still pending)", async () => {
    const markOutcome = vi.fn(async () => {
      throw new Error("dedupe write fail");
    });
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 100,
        phase: "deploy_client_complete",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      orchestrate: vi.fn(async () => okResult),
      markOutcome
    });
    expect(result.kind).toBe("retry_failed");
    if (result.kind === "retry_failed") {
      expect(result.error).toMatch(/cutover still pending/);
    }
    expect(markOutcome).toHaveBeenCalledWith(BIZ, "failed", expect.stringContaining("cutover"));
  });

  it("resumes mid-deploy then leaves cutover pending (does not fake success)", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    const resumeMigrationDeploy = vi.fn(async () => okResult);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      resumeMigrationDeploy,
      orchestrate,
      markOutcome
    });
    expect(result.kind).toBe("retry_failed");
    if (result.kind === "retry_failed") {
      expect(result.error).toMatch(/cutover still pending/);
    }
    expect(resumeMigrationDeploy).toHaveBeenCalled();
    expect(orchestrate).not.toHaveBeenCalled();
  });

  // orchestrateProvisioning sets the business "offline" at 22%, before the
  // deploy phase, and only restores "online" after it. So mid-deploy (exactly
  // the window this recovery exists for) the status is "offline", and gating
  // the migration-safe branches on "online" sent term_renewal straight to full
  // orchestrate with skip_pool_adopt: true, which purchases another VPS.
  it("resumes mid-deploy while the business is offline, never re-purchasing", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    const resumeMigrationDeploy = vi.fn(async () => okResult);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "offline"),
      getLatestProgress: vi.fn(async () => ({
        percent: 60,
        phase: "remote_deploy_running",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      resumeMigrationDeploy,
      orchestrate,
      markOutcome
    });
    expect(result.kind).toBe("retry_failed");
    expect(resumeMigrationDeploy).toHaveBeenCalled();
    expect(orchestrate).not.toHaveBeenCalled();
  });

  // Same window, but the deploy had already finished before the function died:
  // settle rather than re-run orchestrate.
  it("settles a deploy-complete migration while the business is offline", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "offline"),
      getLatestProgress: vi.fn(async () => ({
        percent: 100,
        phase: "deploy_client_complete",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      orchestrate,
      markOutcome
    });
    expect(result.kind).toBe("retry_failed");
    expect(orchestrate).not.toHaveBeenCalled();
    expect(markOutcome).toHaveBeenCalledWith(BIZ, "failed", expect.stringContaining("cutover"));
  });

  it("does not settle on percent 100 without phase complete (cutover pending)", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "migrate_size",
      suppress_owner_notify: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 100,
        phase: "deploy_client_complete",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      orchestrate: vi.fn(async () => okResult),
      markOutcome
    });
    expect(result.kind).toBe("retry_failed");
  });

  it("re-runs full orchestrate for early migration failures (pre-deploy)", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "migrate_size",
      suppress_owner_notify: true,
      skip_pool_adopt: false
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 5,
        phase: "started",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      orchestrate,
      markOutcome
    });
    expect(result).toEqual({ kind: "retried", businessId: BIZ, attempts: 2 });
    expect(orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        suppressOwnerNotify: true
      })
    );
  });

  it("tolerates markOutcome throw on cutover-pending (phase complete)", async () => {
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 100,
        phase: "complete",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "success" as const
      })),
      orchestrate: vi.fn(async () => okResult),
      markOutcome: vi.fn(async () => {
        throw new Error("settle fail");
      })
    });
    expect(result.kind).toBe("retry_failed");

    const result2 = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 100,
        phase: "complete",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "success" as const
      })),
      orchestrate: vi.fn(async () => okResult),
      markOutcome: vi.fn(async () => {
        throw "settle string fail";
      })
    });
    expect(result2.kind).toBe("retry_failed");
  });

  it("treats percent 100 without phase complete as cutover-pending", async () => {
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "migrate_size",
      suppress_owner_notify: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 100,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      orchestrate: vi.fn(async () => okResult),
      markOutcome: vi.fn(async () => undefined)
    });
    expect(result).toMatchObject({
      kind: "retry_failed",
      error: expect.stringMatching(/cutover still pending/)
    });
  });

  it("resumes mid-deploy even when post-resume markOutcome throws", async () => {
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      resumeMigrationDeploy: vi.fn(async () => okResult),
      orchestrate: vi.fn(async () => okResult),
      markOutcome: vi.fn(async () => {
        throw "settle string fail";
      })
    });
    expect(result.kind).toBe("retry_failed");
  });

  it("reports retry_failed when mid-deploy resume throws (Error and string)", async () => {
    const markOutcome = vi.fn(async () => {
      throw new Error("outcome write fail");
    });
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "term_renewal",
      suppress_owner_notify: true,
      skip_pool_adopt: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      resumeMigrationDeploy: vi.fn(async () => {
        throw new Error("resume boom");
      }),
      orchestrate: vi.fn(async () => okResult),
      markOutcome
    });
    expect(result).toEqual({
      kind: "retry_failed",
      businessId: BIZ,
      attempts: 2,
      error: "resume boom"
    });

    const result2 = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking" as const
      })),
      resumeMigrationDeploy: vi.fn(async () => {
        throw "resume string boom";
      }),
      orchestrate: vi.fn(async () => okResult),
      markOutcome
    });
    expect(result2).toMatchObject({
      kind: "retry_failed",
      error: "resume string boom"
    });
  });

  it("falls through to orchestrate when migration progress lookup throws (Error and string)", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    const migrationJob: ProvisioningJobRow = {
      ...JOB_ROW,
      purpose: "migrate_size",
      suppress_owner_notify: true
    };
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => {
        throw new Error("progress down");
      }),
      orchestrate,
      markOutcome
    });
    expect(result.kind).toBe("retried");
    expect(orchestrate).toHaveBeenCalled();

    const orchestrate2 = vi.fn(async () => okResult);
    const result2 = await retryStalledProvisioningJob({
      claim: vi.fn(async () => migrationJob),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      getLatestProgress: vi.fn(async () => {
        throw "progress string down";
      }),
      orchestrate: orchestrate2,
      markOutcome
    });
    expect(result2.kind).toBe("retried");
    expect(orchestrate2).toHaveBeenCalled();
  });

  it("round-trips suppressOwnerNotify and skipPoolAdopt into orchestrate", async () => {
    const markOutcome = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => okResult);
    await runProvisioningJob(
      {
        ...JOB_ROW,
        suppress_owner_notify: true,
        skip_pool_adopt: true,
        purpose: "migrate_size"
      },
      { orchestrate, markOutcome, markRunning: vi.fn(async () => undefined) }
    );
    expect(orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressOwnerNotify: true,
        skipPoolAdopt: true
      })
    );
    // Cutover still pending: do not mark the ledger succeeded yet.
    expect(markOutcome).not.toHaveBeenCalledWith(BIZ, "succeeded");
  });

  it("tolerates a settle failure on the already-online path (Error and string shapes)", async () => {
    const result = await retryStalledProvisioningJob({
      claim: vi.fn(async () => JOB_ROW),
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "online"),
      orchestrate: vi.fn(async () => okResult),
      markOutcome: vi.fn(async () => {
        throw new Error("settle down");
      })
    });
    expect(result.kind).toBe("already_online");

    const result2 = await retryStalledProvisioningJob({
      claim: vi.fn(async () => JOB_ROW),
      settleExhausted: noExhausted(),
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
      settleExhausted: noExhausted(),
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
      settleExhausted: noExhausted(),
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
      settleExhausted: noExhausted(),
      getBusinessStatus: vi.fn(async () => "offline"),
      orchestrate: vi.fn(async () => {
        throw "plain failure";
      }),
      markOutcome: vi.fn(async () => undefined)
    });
    expect(result).toMatchObject({ kind: "retry_failed", error: "plain failure" });
  });
});
