import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const webhookMigration = readFileSync(
  join(repoRoot, "supabase/migrations/20260419103000_webhook_reconcile_voice_pool_compliance.sql"),
  "utf8"
);
const edgeHardeningMigration = readFileSync(
  join(repoRoot, "supabase/migrations/20260419120000_telnyx_webhook_claim_rate.sql"),
  "utf8"
);

describe("voice SQL migrations (contract)", () => {
  it("voice_reserve_for_call: included headroom sums reserved_included_seconds only", () => {
    expect(webhookMigration).toMatch(/coalesce\(sum\(reserved_included_seconds\), 0\)\s+into v_reserved_sum/s);
    expect(webhookMigration).not.toMatch(
      /coalesce\(sum\(reserved_total_seconds\), 0\)\s+into v_reserved_sum/s
    );
  });

  it("voice_try_finalize_settlement: allocation path uses snapshot consumer; guard rejects partial debit", () => {
    expect(webhookMigration).toMatch(/consume_voice_bonus_from_allocations/s);
    expect(webhookMigration).toMatch(/perform consume_voice_bonus_seconds\(r\.business_id, commit_bon\)/s);
    expect(webhookMigration).toMatch(/if v_bon_took <> commit_bon then/s);
    expect(webhookMigration).not.toMatch(/commit_bon := v_bon_took/s);
  });

  it("20260419120000: claim lease + rate check + mark_complete clears claim", () => {
    expect(edgeHardeningMigration).toMatch(/claim_until/);
    expect(edgeHardeningMigration).toMatch(/'status', 'busy'/);
    expect(edgeHardeningMigration).toMatch(/telnyx_webhook_rate_check/);
    expect(edgeHardeningMigration).toMatch(/claim_until = null/);
  });
});
