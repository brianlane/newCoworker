/**
 * Co-tenanted VPS hardware: boxes that run something BESIDES this platform's
 * per-tenant stack.
 *
 * Every tenant box is normally ours alone, which is what lets the fleet
 * tooling treat "re-image it" as a safe, idempotent recovery step: anything
 * that matters is either in Supabase or restored by deploy-client.sh. That
 * assumption breaks the moment a second product installs a service on the
 * same machine. A hardware migration, an adopt/recreate, or a BYOS host
 * correction wipes the co-tenant's files and systemd units with no warning
 * and no backup, because our tooling has never heard of them.
 *
 * This registry is the one place that knows. It is deliberately hand-written
 * and tiny: co-tenancy is a decision someone makes on purpose, not state to
 * discover at runtime. Every destructive fleet path looks a business up here
 * and either refuses (operator tooling, where an ack flag is the escape
 * hatch) or logs loudly (live provisioning, which must never gain a new way
 * to fail).
 *
 * Jul 2026: the ONLY entry is our own internal HQ tenant, whose box now also
 * hosts the JobArms render sidecar. No customer box is shared, and none
 * should be: the isolation story the security posture sells rests on it.
 */

import type { VpsSize } from "@/lib/vps/size";

/**
 * New Coworker (HQ, internal): the fleet's smoke/e2e target tenant, the
 * homepage demo voice line, and the site webchat. Historically retyped in
 * every debug/one-shot script that defaults to it; new code should import it
 * from here so the registry and the smoke-target default cannot drift.
 */
export const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

/** A service on the box that belongs to a different product. */
export type CoTenantService = {
  /** What it is, for the operator reading the refusal. */
  name: string;
  /** Which product owns it, so the operator knows who has to redeploy. */
  product: string;
  /** systemd units a re-image destroys. */
  units: readonly string[];
  /** Loopback port it binds, when it serves HTTP. */
  port?: number;
  /** Filesystem paths a re-image destroys. */
  paths: readonly string[];
  /** Which Cloudflare account fronts it, when it brings its own tunnel. */
  tunnel?: string;
  /** The rollback: how to take it off the box entirely. */
  removal: string;
};

/** A box that carries at least one {@link CoTenantService}. */
export type SharedHardwareEntry = {
  businessId: string;
  /** Tenant name, so a refusal reads as a place and not a uuid. */
  businessName: string;
  /** Hostinger virtual machine id, the handle the migration tooling uses. */
  vmId: number;
  hostname: string;
  vpsSize: VpsSize;
  /** Why the sharing exists, and anything an operator must weigh. */
  note: string;
  coTenants: readonly CoTenantService[];
};

export const SHARED_HARDWARE: readonly SharedHardwareEntry[] = [
  {
    businessId: HQ_BUSINESS_ID,
    businessName: "New Coworker (HQ, internal)",
    vmId: 1806097,
    hostname: "srv1806097.hstgr.cloud",
    vpsSize: "kvm1",
    note:
      "Shared with JobArms (Jul 2026, our own second product) to avoid paying for a second " +
      "box before it has users. 1 vCPU / 4GB carrying two Chromium sidecars, so this box is " +
      "resource-tight BY DECISION: it also answers the homepage demo voice line over Gemini " +
      "Live, and realtime audio is the first thing to suffer. Watch the memory_headroom " +
      "posture check before blaming the voice bridge.",
    coTenants: [
      {
        name: "jobarms-render (headless Chromium for ATS applications)",
        product: "JobArms",
        units: ["jobarms-render.service", "cloudflared-jobarms.service"],
        port: 8085,
        paths: ["/opt/jobarms-render", "/var/lib/jobarms-render"],
        tunnel: "JobArms Cloudflare account, browser.jobarms.com",
        removal: "systemctl disable --now jobarms-render cloudflared-jobarms"
      }
    ]
  }
];

/** The registry entry for a business, or null when its box is ours alone. */
export function sharedHardwareFor(businessId: string): SharedHardwareEntry | null {
  return SHARED_HARDWARE.find((e) => e.businessId === businessId) ?? null;
}

/**
 * The registry entry for a Hostinger VM id. Migration tooling often knows the
 * box before it knows (or trusts) the business row, and an adopt run targets
 * a VM id directly.
 */
export function sharedHardwareForVm(vmId: number): SharedHardwareEntry | null {
  return SHARED_HARDWARE.find((e) => e.vmId === vmId) ?? null;
}

/**
 * The operator-facing block: what else lives on the box, what a re-image
 * destroys, and how to remove it cleanly instead. Plain text, so it reads the
 * same in a terminal, a log line, and an ops email.
 */
export function sharedHardwareWarning(entry: SharedHardwareEntry): string {
  const lines: string[] = [
    `VM ${entry.vmId} (${entry.hostname}) is SHARED HARDWARE.`,
    `  business : ${entry.businessName} ${entry.businessId} (${entry.vpsSize})`,
    `  note     : ${entry.note}`,
    "",
    "  Re-imaging, replacing, or recreating this box DESTROYS the services below.",
    "  Our tooling does not back them up and cannot restore them: their owner has to redeploy."
  ];
  for (const svc of entry.coTenants) {
    lines.push("", `  - ${svc.name} [${svc.product}]`);
    lines.push(`      units  : ${svc.units.join(", ")}`);
    if (svc.port !== undefined) lines.push(`      port   : 127.0.0.1:${svc.port}`);
    lines.push(`      paths  : ${svc.paths.join(", ")}`);
    if (svc.tunnel !== undefined) lines.push(`      tunnel : ${svc.tunnel}`);
    lines.push(`      remove : ${svc.removal}`);
  }
  return lines.join("\n");
}
