/**
 * vps-posture-check.ts: run the daily VPS billing-posture check read-only and
 * print what today's ops email would say.
 *
 * The check itself only runs from a cron (`edge-vps-billing-posture`, 13:00
 * UTC) and only speaks through an email it sends when it finds something, so
 * "is the fleet clean right now?" was a question you could only answer by
 * waiting a day. This asks it directly.
 *
 * Read-only by construction. `checkVpsBillingPosture` takes every dependency
 * by injection; this passes the same real READ deps the production route
 * (`src/app/api/internal/vps-billing-posture/route.ts`) wires up, and replaces
 * its only two write deps with recorders:
 *
 *   enableAutoRenewal    would commit the account to a renewal charge
 *   retireLapsedPoolVps  would write vps_inventory
 *
 * The recorders RESOLVE rather than throw, on purpose. Both call sites are
 * wrapped in try/catch that degrades the finding's text on failure, so a
 * throwing stub would produce findings whose wording ("re-enable FAILED")
 * describes the stub instead of the fleet. Resolving keeps every finding
 * identical to what production would report; what did not actually happen is
 * printed separately, under its own heading, and any finding the check
 * believes it healed is labelled WOULD AUTO-HEAL rather than healed.
 *
 * Nothing is emailed. Also skips the production route's
 * `refreshVpsInventoryExpiresAt` call, which is a write.
 *
 * Usage:
 *   npx tsx debug/vps-posture-check.ts
 */
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();

const { listBusinesses } = await import("../src/lib/db/businesses.ts");
const { listBusinessIdsWithLiveSubscription } = await import("../src/lib/db/subscriptions.ts");
const { listVpsInventory } = await import("../src/lib/db/vps-inventory.ts");
const { listHostingerBillingTerms } = await import("../src/lib/db/hostinger-billing-terms.ts");
const { checkVpsBillingPosture, isLapseRiskFinding, selectEmailWorthyFindings } = await import(
  "../src/lib/vps/billing-posture.ts"
);
type BillingPostureFinding = import("../src/lib/vps/billing-posture.ts").BillingPostureFinding;

const hostinger = makeHostingerClient();
// One billing list for the whole run, exactly as the route does: the tenant
// pass and the pool pass must not see two different snapshots.
const billingSubs = await hostinger.listBillingSubscriptions();

const wouldHaveWritten: string[] = [];

const result = await checkVpsBillingPosture({
  listBusinesses,
  listBusinessIdsWithLiveSubscription,
  listInventory: listVpsInventory,
  getVirtualMachine: (vmId) => hostinger.getVirtualMachine(vmId),
  listVirtualMachines: () => hostinger.listVirtualMachines(),
  listBillingSubscriptions: async () => billingSubs,
  enableAutoRenewal: async (subscriptionId) => {
    wouldHaveWritten.push(
      `enable Hostinger auto-renew on subscription ${subscriptionId} (a renewal CHARGE)`
    );
  },
  // true = "retired"; false would mean "claimed mid-run", which makes the
  // check drop the finding entirely and hide it from this report.
  retireLapsedPoolVps: async (vmId, reason) => {
    wouldHaveWritten.push(`retire vps_inventory row for VM ${vmId} (${reason})`);
    return true;
  },
  listBillingTerms: () => listHostingerBillingTerms()
});

// First-day view of the email gate: a Hostinger timeout/network error is
// held as warn. This rehearsal does not write system_logs, so it cannot
// see yesterday's row. Production emails only if recordFailure already has
// a failure in the 48h window.
const { heldTransient } = await selectEmailWorthyFindings(result.findings, async () => "warn");

const label = (finding: BillingPostureFinding): string => {
  if (heldTransient.includes(finding)) {
    return "LAPSE RISK, emailed only if this lookup already failed in the last 48h";
  }
  return isLapseRiskFinding(finding) ? "LAPSE RISK" : "advisory";
};

console.log(
  `\n== VPS billing posture (read-only) ==\n` +
    `checked ${result.checkedTenantVms} tenant VMs, ${result.checkedPoolBoxes} pooled boxes`
);

if (result.findings.length === 0) {
  console.log(`\nCLEAN: no findings, so the cron would send no email at all.`);
} else {
  const needsHuman = result.findings.filter((f) => !f.autoHealed);
  const healed = result.findings.filter((f) => f.autoHealed);
  console.log(
    `\n${result.findings.length} finding(s): ${needsHuman.length} needing a human, ` +
      `${healed.length} the cron would auto-heal.`
  );

  for (const f of needsHuman) {
    console.log(
      `\n[${label(f)}] ${f.kind}` +
        `\n  vm       : ${f.vmId ?? "none"}` +
        `\n  business : ${f.businessName ?? f.businessId ?? "none"}` +
        `\n  sub      : ${f.hostingerBillingSubscriptionId ?? "none"}` +
        `\n  expires  : ${f.expiresAt ?? "unknown"}` +
        `\n  ${f.detail}`
    );
  }
  for (const f of healed) {
    // The detail text is production's wording, which is written as though the
    // heal already happened. It did not: see the section below.
    console.log(
      `\n[WOULD AUTO-HEAL] ${f.kind}` +
        `\n  vm       : ${f.vmId ?? "none"}` +
        `\n  business : ${f.businessName ?? f.businessId ?? "none"}` +
        `\n  ${f.detail}`
    );
  }
}

if (wouldHaveWritten.length > 0) {
  console.log(`\n== NOT PERFORMED (this script never writes) ==`);
  for (const w of wouldHaveWritten) console.log(`  - ${w}`);
  console.log(`\nThe real cron at 13:00 UTC would do the above.`);
}
