/**
 * Idempotent helper for delegating a subdomain into its own Cloudflare zone.
 *
 * Background — why we do this at all:
 *   * Per-tenant tunnels publish hostnames at `<businessId>.tunnel.<root>`.
 *     Inside a single root zone like `newcoworker.com`, that's TWO levels
 *     of subdomain. Cloudflare's free Universal SSL only covers the apex
 *     and one level of wildcard (`*.<root>`), so multi-level hostnames
 *     fall back to a self-signed edge cert — exactly the
 *     `sslv3 alert handshake failure` we hit on `brianlanefanmail`.
 *   * Total TLS / Advanced Certificate Manager fixes that, but ACM is
 *     a $10/month-per-zone paid add-on (see Cloudflare's pricing page).
 *   * Splitting `tunnel.<root>` off as ITS OWN zone collapses the
 *     hostname back to a single wildcard level (`*.tunnel.<root>` is
 *     `*.<child-zone>`), which Universal SSL covers for free on every
 *     plan including Free. Only requirement: NS-delegate the subdomain
 *     from the parent zone. This is documented at
 *     https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/parent-on-full/.
 *
 * Three operations, all idempotent:
 *   1. {@link ensureChildZone} — add `tunnel.<root>` as a new zone (no-op
 *      if it already exists in the same account).
 *   2. {@link ensureNsDelegation} — write the two `tunnel` NS records
 *      into the parent zone pointing at the child's nameservers (no-op
 *      if they already match).
 *   3. {@link migrateTunnelCnamesToChildZone} — copy any existing
 *      `<biz>.tunnel.<root>` CNAMEs from the parent zone into the
 *      child zone and delete them from the parent (so the existing
 *      tenant doesn't lose connectivity during the cutover).
 *
 * All three are surfaced through {@link ensureTunnelSubzone}, which is
 * the only export the orchestrator / oneshot CLI should use. Tests
 * exercise the building blocks in isolation; this aggregator is just
 * orchestration glue.
 *
 * Token requirements:
 *   * `apiToken` must include `Account: Zone:Edit` (zone create) +
 *     `Zone: DNS:Edit` on both the parent and the (newly-created)
 *     child zones. The default `CLOUDFLARE_API_TOKEN` we already use
 *     for tunnel + DNS work usually covers this once the operator
 *     ticks the "Zone — Zone:Edit" scope at the account level. A
 *     `403/9109` here means the operator needs to widen the token
 *     in the dashboard before re-running.
 */

import { logger } from "@/lib/logger";

type CfEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: unknown;
  result: T;
};

type CfZone = {
  id: string;
  name: string;
  name_servers?: string[];
  status?: string;
  account?: { id: string };
};

type CfDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
};

export type CloudflareSubzoneClientConfig = {
  /** Bearer token. Needs Account:Zone:Edit + Zone:DNS:Edit on parent + child. */
  apiToken: string;
  /** Account that owns both the parent and the new child zone. */
  accountId: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
};

function envelopeErrorMessage(body: CfEnvelope<unknown>): string {
  /* c8 ignore next -- defensive: api() only constructs the error from
     non-success bodies, all of which carry an errors[] today. The empty
     fallback exists so a future CF API shape regression doesn't surface
     as `undefined` in our error message. */
  if (!body.errors || body.errors.length === 0) return "unknown error";
  return body.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
}

function makeApi(config: CloudflareSubzoneClientConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  return async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
    let body: CfEnvelope<T>;
    try {
      body = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new Error(`Cloudflare API ${path} returned non-JSON (status ${res.status})`);
    }
    if (!body.success) {
      throw new Error(`Cloudflare API ${path} failed: ${envelopeErrorMessage(body)}`);
    }
    return body.result;
  };
}

/**
 * Add `<childName>` to the same Cloudflare account as a new full-setup
 * zone, OR return the existing zone if it's already there. Returns the
 * zone id + the two assigned nameservers (which the parent zone's NS
 * records need to point at).
 *
 * Why we look up before posting: `POST /zones` is NOT idempotent — a
 * second call against an already-active zone returns `1061 zone already
 * exists`. We treat the lookup hit as success rather than blowing up,
 * so re-running this helper after a partial failure is safe.
 */
export async function ensureChildZone(
  config: CloudflareSubzoneClientConfig,
  childName: string
): Promise<{ zoneId: string; nameServers: string[]; created: boolean }> {
  const api = makeApi(config);
  const existing = await api<CfZone[]>(
    `/zones?name=${encodeURIComponent(childName)}&account.id=${encodeURIComponent(config.accountId)}`
  );
  if (
    /* c8 ignore next -- defensive: CF returns [] (truthy, empty) not null when no zones match; this guard exists in case a future API version starts returning null */
    existing && existing.length > 0
  ) {
    const z = existing[0];
    const ns = z.name_servers ?? [];
    if (ns.length < 2) {
      // The zone exists but Cloudflare hasn't finished assigning NS
      // records yet. This window is usually <1s on creation; if we hit
      // it the operator should re-run after a few seconds. Failing
      // loud beats silently writing partial NS delegation.
      throw new Error(
        `child zone ${childName} (id=${z.id}) has not been assigned nameservers yet — retry in a few seconds`
      );
    }
    logger.info("cloudflare child zone already present", {
      childName,
      zoneId: z.id,
      nameServerCount: ns.length
    });
    return { zoneId: z.id, nameServers: ns, created: false };
  }

  // Zone doesn't exist yet — create it. `type: "full"` makes Cloudflare
  // authoritative for the child (i.e. assigns it its own NS records,
  // which is what we want for free Universal SSL on the wildcard).
  const created = await api<CfZone>(`/zones`, {
    method: "POST",
    body: JSON.stringify({
      name: childName,
      account: { id: config.accountId },
      type: "full"
    })
  });
  /* c8 ignore start -- Cloudflare assigns NS atomically on POST /zones in
     production; the empty-array / missing-field path is reserved for a
     hypothetical API regression. We surface a loud error rather than
     silently writing a half-delegation. */
  const createdNs = created.name_servers ?? [];
  if (createdNs.length < 2) {
    throw new Error(
      `child zone ${childName} created (id=${created.id}) but Cloudflare returned no nameservers`
    );
  }
  /* c8 ignore stop */
  logger.info("cloudflare child zone created", {
    childName,
    zoneId: created.id,
    nameServers: createdNs
  });
  return { zoneId: created.id, nameServers: createdNs, created: true };
}

/**
 * Idempotently write two NS records into the parent zone delegating
 * `<subLabel>.<parentName>` to the supplied nameservers. Cleans up any
 * legacy address (A/AAAA/CNAME) records on the same name first — the
 * Cloudflare docs require that when the subdomain previously existed
 * in the parent zone, "delete all the remaining records on the
 * delegated subdomain, except the NS records that you created".
 *
 * Returns the count of records created/updated/deleted so the CLI can
 * surface a useful summary.
 */
/**
 * Match a DNS record's `name` against the delegated label. Cloudflare's
 * DNS API returns `name` as the FULL FQDN (e.g. `tunnel.newcoworker.com`)
 * even when the record was POSTed with just the bare label, so we have
 * to accept both forms here. Deeper records (e.g.
 * `biz-1.tunnel.newcoworker.com`) are explicitly NOT a match — those
 * are tenant CNAMEs handled by the migrate step.
 */
function nameMatchesExactLabel(recordName: string, subLabel: string): boolean {
  const lname = recordName.toLowerCase();
  const lsub = subLabel.toLowerCase();
  if (lname === lsub) return true;
  // FQDN form: `<subLabel>.<rest>` where <rest> contains no dot before
  // the next sub-label boundary OR is the parent zone tail. Equivalent
  // to "starts with `<subLabel>.` and the segment immediately before
  // `<subLabel>` (if any) doesn't exist." Since `lname` is the full
  // record name, we just check that it begins with `<subLabel>.`.
  return lname.startsWith(`${lsub}.`);
}

export async function ensureNsDelegation(
  config: CloudflareSubzoneClientConfig,
  parentZoneId: string,
  subLabel: string,
  nameServers: string[]
): Promise<{ nsCreated: number; nsUpdated: number; legacyDeleted: number }> {
  const api = makeApi(config);

  // Step 1: enumerate every record under the delegated label so we
  // know what's there. We need ALL records — A, AAAA, CNAME, NS, TXT,
  // etc. — because the delegation contract requires the delegated
  // subdomain to carry only NS records in the parent zone.
  const allRaw = await api<CfDnsRecord[] | null>(
    `/zones/${parentZoneId}/dns_records?per_page=100&search=${encodeURIComponent(subLabel)}`
  );
  /* c8 ignore next -- defensive: CF returns [] (not null) when no records match; `?? []` keeps the helper crash-proof against an upstream regression */
  const all = allRaw ?? [];
  // The exact filter is shared between the legacy-cleanup step and
  // the NS reconciliation step below. We use the same predicate so
  // the two stages always agree on what counts as "the delegated
  // label" — preventing the silent-skip bug where production CF
  // returns FQDN-form names but only bare-label names get acted on.
  const exact = all.filter((r) => nameMatchesExactLabel(r.name, subLabel));

  let nsCreated = 0;
  let nsUpdated = 0;
  let legacyDeleted = 0;

  // Step 2: delete any non-NS record at the delegated label. Doing this
  // before adding NS records avoids the parent-zone validation error
  // "CNAME and other records cannot coexist on the same name".
  for (const r of exact) {
    if (r.type === "NS") continue;
    await api(`/zones/${parentZoneId}/dns_records/${r.id}`, {
      method: "DELETE"
    });
    legacyDeleted += 1;
    logger.info("cloudflare deleted legacy record on delegated label", {
      parentZoneId,
      recordId: r.id,
      type: r.type,
      name: r.name
    });
  }

  // Step 3: ensure exactly one NS record per supplied nameserver. We
  // match on (name == delegated label, in either bare or FQDN form)
  // AND (type == NS); content is the nameserver. Existing NS records
  // pointing at the right NS stay; ones pointing at a different NS
  // get patched; missing ones get POSTed. We don't delete
  // extra/legacy NS records pointing at OTHER nameservers —
  // Cloudflare only honors the ones that match the child zone's
  // actual NS, so leaving them is harmless and avoids surprising the
  // operator if they manually added a third for redundancy.
  const existingNs = exact.filter((r) => r.type === "NS");
  const existingByContent = new Map<string, CfDnsRecord>();
  for (const r of existingNs) {
    existingByContent.set(r.content.toLowerCase(), r);
  }

  for (const ns of nameServers) {
    const lower = ns.toLowerCase();
    const hit = existingByContent.get(lower);
    if (hit) {
      // Already there with the right content — nothing to do.
      continue;
    }
    // Try to repurpose an existing NS slot before creating a new one,
    // to keep the dashboard tidy in re-run scenarios.
    const reuseTarget = existingNs.find(
      (r) => !nameServers.some((want) => want.toLowerCase() === r.content.toLowerCase())
    );
    if (reuseTarget) {
      await api(`/zones/${parentZoneId}/dns_records/${reuseTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify({ type: "NS", name: subLabel, content: ns })
      });
      nsUpdated += 1;
      // Drop the reused record from the candidate pool so the next
      // iteration doesn't pick the same slot.
      const idx = existingNs.indexOf(reuseTarget);
      existingNs.splice(idx, 1);
      continue;
    }
    await api(`/zones/${parentZoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "NS",
        name: subLabel,
        content: ns,
        comment: "newCoworker: delegate to child zone for free per-hostname Universal SSL"
      })
    });
    nsCreated += 1;
  }

  logger.info("cloudflare NS delegation ensured", {
    parentZoneId,
    subLabel,
    nameServers,
    nsCreated,
    nsUpdated,
    legacyDeleted
  });
  return { nsCreated, nsUpdated, legacyDeleted };
}

/**
 * Move every CNAME record under `<*>.<delegatedLabel>` from the parent
 * zone into the child zone. We do this before flipping production env
 * vars so existing tenants don't experience a DNS-resolution gap.
 *
 * Idempotent: re-running after a partial migration is safe — records
 * already in the child are upserted (matched on hostname + content),
 * records still in the parent are deleted only after the child copy is
 * confirmed.
 */
export async function migrateTunnelCnamesToChildZone(
  config: CloudflareSubzoneClientConfig,
  parentZoneId: string,
  childZoneId: string,
  delegatedLabel: string,
  parentZoneName: string
): Promise<{ migrated: number; deletedFromParent: number; alreadyInChild: number }> {
  const api = makeApi(config);
  // Inventory parent-zone records under the delegated label. Pagination
  // ceiling is 100 here because we do not anticipate >100 active
  // tenants on a single tunnel zone before cutover; a follow-up loop
  // is trivial to add if that changes.
  const parentRecordsRaw = await api<CfDnsRecord[] | null>(
    `/zones/${parentZoneId}/dns_records?per_page=100&type=CNAME&search=${encodeURIComponent(delegatedLabel)}`
  );
  /* c8 ignore next -- defensive: CF returns [] (not null); `?? []` is a crash guard for a hypothetical upstream regression */
  const parentRecords = parentRecordsRaw ?? [];
  const fqdnSuffix = `.${delegatedLabel}.${parentZoneName}`.toLowerCase();
  const tunnelCnames = parentRecords.filter(
    (r) =>
      r.type === "CNAME" &&
      // Match `<anything>.<delegatedLabel>.<parentZoneName>` — i.e. one
      // or more labels deeper than the delegated boundary. This skips
      // the apex + delegated-label record itself (which the NS step
      // handles) and is robust against CF returning the FQDN with or
      // without a trailing dot.
      r.name.toLowerCase().endsWith(fqdnSuffix)
  );

  let migrated = 0;
  let alreadyInChild = 0;
  let deletedFromParent = 0;

  for (const rec of tunnelCnames) {
    // Look up child-zone state for this hostname before touching the
    // parent — gives us idempotency: re-runs see the child already
    // populated and just clean up parent residue.
    const childExisting = await api<CfDnsRecord[]>(
      `/zones/${childZoneId}/dns_records?type=CNAME&name=${encodeURIComponent(rec.name)}`
    );
    if (childExisting && childExisting.length > 0) {
      alreadyInChild += 1;
    } else {
      await api(`/zones/${childZoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: "CNAME",
          name: rec.name,
          content: rec.content,
          proxied: rec.proxied ?? true,
          comment: "newCoworker: migrated from parent zone during subzone cutover"
        })
      });
      migrated += 1;
    }

    // Only delete the parent record AFTER we know the child has it,
    // so a mid-loop crash never produces a "record exists nowhere"
    // window that would 5xx every tenant request to that hostname.
    await api(`/zones/${parentZoneId}/dns_records/${rec.id}`, {
      method: "DELETE"
    });
    deletedFromParent += 1;
  }

  logger.info("cloudflare tunnel CNAMEs migrated to child zone", {
    parentZoneId,
    childZoneId,
    delegatedLabel,
    migrated,
    alreadyInChild,
    deletedFromParent
  });
  return { migrated, deletedFromParent, alreadyInChild };
}

export type EnsureTunnelSubzoneInput = {
  /** Parent zone name, e.g. "newcoworker.com". */
  parentZoneName: string;
  /** Parent zone id (Cloudflare). */
  parentZoneId: string;
  /** Sublabel to delegate, e.g. "tunnel" → produces `tunnel.<parent>`. */
  delegatedLabel: string;
};

export type EnsureTunnelSubzoneResult = {
  childZoneId: string;
  childZoneName: string;
  nameServers: string[];
  childCreated: boolean;
  delegationCreated: number;
  delegationUpdated: number;
  legacyDeletedFromParent: number;
  cnamesMigrated: number;
  cnamesAlreadyInChild: number;
  cnamesDeletedFromParent: number;
};

/**
 * One-shot driver: ensure the child zone exists, ensure parent NS
 * delegation, migrate any existing per-tenant CNAMEs from parent to
 * child. Idempotent end-to-end so the operator can re-run safely if any
 * step partially completes.
 *
 * After this returns successfully, the operator should:
 *   1. Wait for child-zone activation (Cloudflare returns
 *      `status: "pending"` until the parent NS records propagate; usual
 *      window is <5min when both zones are on Cloudflare in the same
 *      account, since the apex NS lookup is internal).
 *   2. Update `CLOUDFLARE_ZONE_ID` to the child zone id and
 *      `CLOUDFLARE_TUNNEL_ZONE` to the child zone name in `.env` and
 *      Vercel.
 *   3. Re-run the orchestrator's tunnel provisioner for each existing
 *      tenant if the cutover left them in a broken state (the
 *      migration above keeps DNS continuous; only re-running is
 *      necessary if a tenant's tunnel needs new ingress rules).
 */
export async function ensureTunnelSubzone(
  config: CloudflareSubzoneClientConfig,
  input: EnsureTunnelSubzoneInput
): Promise<EnsureTunnelSubzoneResult> {
  const childZoneName = `${input.delegatedLabel}.${input.parentZoneName}`;

  const child = await ensureChildZone(config, childZoneName);
  const delegation = await ensureNsDelegation(
    config,
    input.parentZoneId,
    input.delegatedLabel,
    child.nameServers
  );
  const migration = await migrateTunnelCnamesToChildZone(
    config,
    input.parentZoneId,
    child.zoneId,
    input.delegatedLabel,
    input.parentZoneName
  );

  return {
    childZoneId: child.zoneId,
    childZoneName,
    nameServers: child.nameServers,
    childCreated: child.created,
    delegationCreated: delegation.nsCreated,
    delegationUpdated: delegation.nsUpdated,
    legacyDeletedFromParent: delegation.legacyDeleted,
    cnamesMigrated: migration.migrated,
    cnamesAlreadyInChild: migration.alreadyInChild,
    cnamesDeletedFromParent: migration.deletedFromParent
  };
}
