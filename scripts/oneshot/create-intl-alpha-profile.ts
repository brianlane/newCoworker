#!/usr/bin/env tsx
/**
 * One-shot: create the dedicated "New Coworker International Alerts"
 * messaging profile carrying the platform's alphanumeric sender ID.
 *
 * Why a DEDICATED profile: the alpha sender is a platform-branded identity
 * (NEWCOWORKER) and the RCS record (PRDs/tier-economics-jul-2026.md, Jul 18
 * 2026 decision) says shared branded senders carry PLATFORM traffic only,
 * never customer-facing messages. Isolating the sender on its own profile,
 * with no numbers attached, means no tenant send can ride it by accident;
 * only the owner-alert code paths that explicitly target
 * TELNYX_INTL_ALPHA_PROFILE_ID ever touch it.
 *
 * Why the readback matters: Telnyx has form on 200-and-ignore PATCHes (the
 * messaging_product field accepts writes on every endpoint and persists
 * none of them, Aug 2026), and a GET of an existing profile does not even
 * list an `alpha_sender` key. This script REFUSES to report success unless
 * the created/updated profile reads back with the exact sender string, so
 * "the field silently does not exist" fails loudly here instead of at the
 * first live alert.
 *
 * Creating the profile before Telnyx approves the sender registration is
 * deliberate prep: an unregistered alpha sender simply does not deliver,
 * and nothing routes through the profile until the env secret is set
 * (see PRDs/alpha-sender-rollout.md for the activation order).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/create-intl-alpha-profile.ts            # dry run
 *   npx tsx scripts/oneshot/create-intl-alpha-profile.ts --apply    # create/converge
 *
 * Optional: ALPHA_SENDER_ID overrides the sender string (default NEWCOWORKER).
 * Required env: TELNYX_API_KEY, and Supabase env for the ledger
 * (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 * Exit codes: 0 converged/dry-run · 1 API error · 2 bad env or readback mismatch.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { allowedCountries } from "./widen-telnyx-allowlist";
import { recordOneshotApplied } from "./_ledger";

export const PROFILE_NAME = "New Coworker International Alerts";
export const DEFAULT_ALPHA_SENDER = "NEWCOWORKER";

const APPLY = process.argv.includes("--apply");

async function telnyx(
  key: string,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function findProfileByName(
  key: string
): Promise<{ id: string; alpha_sender?: string | null; whitelisted_destinations?: string[] } | null> {
  for (let page = 1; page <= 50; page += 1) {
    const list = await telnyx(key, `/messaging_profiles?page[size]=50&page[number]=${page}`);
    if (list.status !== 200) {
      throw new Error(`GET /messaging_profiles page ${page}: HTTP ${list.status}`);
    }
    for (const p of list.body?.data ?? []) {
      if (p.name === PROFILE_NAME) return p;
    }
    const totalPages = Number(list.body?.meta?.total_pages ?? 1);
    if (page >= totalPages) break;
  }
  return null;
}

async function main(): Promise<void> {
  const key = process.env.TELNYX_API_KEY ?? "";
  if (!key) {
    console.error("TELNYX_API_KEY missing (repo-root .env)");
    process.exit(2);
  }
  const sender = process.env.ALPHA_SENDER_ID ?? DEFAULT_ALPHA_SENDER;
  if (!/^[A-Za-z0-9]{1,11}$/.test(sender)) {
    console.error(`Alpha sender "${sender}" is invalid: 1-11 alphanumeric characters.`);
    process.exit(2);
  }
  const destinations = allowedCountries();

  const existing = await findProfileByName(key);
  console.log(`Profile "${PROFILE_NAME}": ${existing ? `exists (${existing.id})` : "absent"}`);
  console.log(`Target: alpha_sender=${sender}, ${destinations.length}-country whitelist, no numbers attached`);

  if (!APPLY) {
    console.log(`\n[dry-run] Would ${existing ? "converge" : "create"} the profile. Re-run with --apply.`);
    return;
  }

  const payload = {
    name: PROFILE_NAME,
    enabled: true,
    alpha_sender: sender,
    whitelisted_destinations: destinations
  };
  const res = existing
    ? await telnyx(key, `/messaging_profiles/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      })
    : await telnyx(key, "/messaging_profiles", { method: "POST", body: JSON.stringify(payload) });
  if (res.status !== 200 && res.status !== 201) {
    console.error(`${existing ? "PATCH" : "POST"} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    process.exit(1);
  }
  const id: string = res.body?.data?.id ?? existing?.id ?? "";

  // Trust only the readback (the messaging_product lesson).
  const after = await telnyx(key, `/messaging_profiles/${id}`);
  const gotSender = after.body?.data?.alpha_sender ?? null;
  const gotCountries: string[] = after.body?.data?.whitelisted_destinations ?? [];
  console.log(`\nReadback: id=${id} alpha_sender=${JSON.stringify(gotSender)} countries=${gotCountries.length}`);
  if (gotSender !== sender) {
    console.error(
      `READBACK MISMATCH: alpha_sender is ${JSON.stringify(gotSender)}, wanted "${sender}". ` +
        "Telnyx did not persist the field; do NOT proceed to wire the env secret. " +
        "Ask Telnyx support how alpha senders attach to profiles on this account."
    );
    process.exit(2);
  }
  console.log("  -> alpha sender persisted and verified.");
  console.log(`\nNext (post-approval, see PRDs/alpha-sender-rollout.md): set TELNYX_INTL_ALPHA_PROFILE_ID=${id}`);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (supabaseUrl && serviceKey) {
    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "create-intl-alpha-profile.ts",
      businessId: null,
      details: { profile_id: id, alpha_sender: sender, countries: gotCountries.length }
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
