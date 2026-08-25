import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatOwnerFallbackReasons,
  OWNER_FALLBACK_KIND_LABEL,
  OWNER_FALLBACK_PAGE_AT,
  OWNER_FALLBACK_REASONS,
  ownerFallbackKind,
  tallyOwnerFallbacks,
  type OwnerFallbackRow
} from "@/lib/cron/owner-operator-fallback";

/**
 * The fallback reason vocabulary has a WRITER and READERS that cannot import
 * each other: the writer is Deno
 * (supabase/functions/sms-inbound-worker/index.ts) and the readers are the
 * watchdog and the debug report, both Node. A reason added on one side only
 * would be silently unclassified, and since an unknown reason counts toward
 * the alarm, the failure mode is a false page rather than a silent miss.
 * Either way it should be a test failure, not a surprise at 03:30 UTC.
 *
 * Same shape as tests/star-block.test.ts: read the other side's source and
 * pin the two lists equal.
 */
const ROOT = join(__dirname, "..");
const WORKER = join(ROOT, "supabase/functions/sms-inbound-worker/index.ts");

/** The `OwnerOperatorFallbackReason` union as the Deno worker declares it. */
function workerReasons(): string[] {
  const src = readFileSync(WORKER, "utf8");
  const marker = "type OwnerOperatorFallbackReason =";
  const start = src.indexOf(marker);
  expect(start, "the worker no longer declares OwnerOperatorFallbackReason").toBeGreaterThan(-1);
  const body = src.slice(start + marker.length, src.indexOf(";", start));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

describe("owner-operator fallback vocabulary", () => {
  it("matches the Deno worker's union exactly, in both directions", () => {
    expect(workerReasons()).toEqual([...OWNER_FALLBACK_REASONS].sort());
  });

  it("the worker actually records every reason it declares", () => {
    // A reason in the union that no code path emits is dead vocabulary, and
    // worse, it reads as covered.
    const src = readFileSync(WORKER, "utf8");
    for (const reason of OWNER_FALLBACK_REASONS) {
      expect(src, `no fellBack("${reason}") call in the worker`).toContain(`fellBack("${reason}"`);
    }
  });

  it("the worker records the telemetry event this reader queries", () => {
    expect(readFileSync(WORKER, "utf8")).toContain("sms_owner_operator_fallback");
  });
});

describe("ownerFallbackKind", () => {
  it("splits the vocabulary into config, deliberate and failed", () => {
    expect(ownerFallbackKind("disabled")).toBe("config");
    expect(ownerFallbackKind("not_configured")).toBe("config");
    expect(ownerFallbackKind("over_cap")).toBe("deliberate");
    expect(ownerFallbackKind("http_error")).toBe("failed");
    expect(ownerFallbackKind("bad_payload")).toBe("failed");
    expect(ownerFallbackKind("request_failed")).toBe("failed");
  });

  // The alarm must never be quieted by a reason this code has not met.
  it("counts an unknown reason as failed", () => {
    expect(ownerFallbackKind("brand_new_reason")).toBe("failed");
    expect(ownerFallbackKind("")).toBe("failed");
  });

  it("labels every kind", () => {
    for (const reason of OWNER_FALLBACK_REASONS) {
      expect(OWNER_FALLBACK_KIND_LABEL[ownerFallbackKind(reason)]).toBeTruthy();
    }
  });
});

describe("tallyOwnerFallbacks", () => {
  const row = (reason: string, business_id: string | null = "biz-1"): OwnerFallbackRow => ({
    reason,
    created_at: "2026-08-25T00:00:00Z",
    business_id
  });

  it("counts by reason and by kind", () => {
    const t = tallyOwnerFallbacks([
      row("http_error"),
      row("http_error"),
      row("over_cap"),
      row("disabled")
    ]);
    expect(t.total).toBe(4);
    expect(t.byReason).toEqual({ http_error: 2, over_cap: 1, disabled: 1 });
    expect(t.byKind).toEqual({ config: 1, deliberate: 1, failed: 2 });
  });

  it("lists the businesses that hit a FAILED fallback, deduped and sorted", () => {
    const t = tallyOwnerFallbacks([
      row("http_error", "biz-b"),
      row("http_error", "biz-a"),
      row("http_error", "biz-a"),
      // A deliberate degrade is not a victim of breakage, so it is not listed.
      row("over_cap", "biz-z")
    ]);
    expect(t.failedBusinesses).toEqual(["biz-a", "biz-b"]);
  });

  it("survives a row with no business and a missing reason", () => {
    const t = tallyOwnerFallbacks([
      row("http_error", null),
      { reason: "", created_at: "x" } as OwnerFallbackRow
    ]);
    expect(t.failedBusinesses).toEqual([]);
    expect(t.byReason.unknown).toBe(1);
    expect(t.byKind.failed).toBe(2);
  });

  it("is empty for an empty window", () => {
    const t = tallyOwnerFallbacks([]);
    expect(t).toEqual({
      byReason: {},
      byKind: { config: 0, deliberate: 0, failed: 0 },
      failedBusinesses: [],
      total: 0
    });
  });
});

describe("formatOwnerFallbackReasons", () => {
  it("renders densest first with the group in brackets", () => {
    const line = formatOwnerFallbackReasons(
      tallyOwnerFallbacks([
        { reason: "over_cap", created_at: "x" },
        { reason: "http_error", created_at: "x" },
        { reason: "http_error", created_at: "x" }
      ])
    );
    expect(line).toBe("http_error x2 (attempted and failed), over_cap x1 (deliberate degrade)");
  });

  it("is empty for an empty tally", () => {
    expect(formatOwnerFallbackReasons(tallyOwnerFallbacks([]))).toBe("");
  });
});

describe("the pager bar", () => {
  // Tuned against a measured baseline of zero, not against noise. If this
  // ever needs raising, that means fallbacks became routine, which is the
  // signal to fix the cause rather than the threshold.
  it("is above one, so a lone transient stays quiet", () => {
    expect(OWNER_FALLBACK_PAGE_AT).toBeGreaterThan(1);
  });
});
