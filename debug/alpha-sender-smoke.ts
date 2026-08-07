#!/usr/bin/env tsx
/**
 * Live smoke test for the platform alphanumeric sender (NEWCOWORKER).
 *
 * The RCS lesson this script exists to honor: a fallback-capable channel
 * makes tests lie. A send that quietly leaves on some other route would
 * "pass" while proving nothing, so this script FAILS unless the accepted
 * message actually carries the alpha identity as its sender, read back
 * from Telnyx's own message record, never inferred from our request.
 *
 * It also prints the message's cost and parts once Telnyx materializes
 * them, which settles the per-message vs per-part billing question for
 * the destination country (open since the international work of Aug
 * 2026; see the destination-rates module docs).
 *
 * Run AFTER Telnyx approves the sender registration and
 * TELNYX_INTL_ALPHA_PROFILE_ID is set (PRDs/alpha-sender-rollout.md).
 * Refuses domestic (US/CA) destinations: the alpha sender is
 * international-owner-alert plumbing, never a domestic identity.
 *
 * Platform-level test send: not metered against any tenant.
 *
 *   set -a && source .env && set +a
 *   npx tsx debug/alpha-sender-smoke.ts --to +85261234567            # dry run
 *   npx tsx debug/alpha-sender-smoke.ts --to +85261234567 --apply    # send + verify
 */
import { loadEnv } from "./_shared";
import { smsDestinationCountry } from "../supabase/functions/_shared/sms_destination_rates";
import { isInternationalSmsDestination } from "../supabase/functions/_shared/sms_international_gateway";
import {
  ALPHA_NO_REPLY_LINE,
  intlAlphaProfileId
} from "../supabase/functions/_shared/alpha_sender";

loadEnv();

const APPLY = process.argv.includes("--apply");

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function telnyx(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY ?? ""}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const to = arg("--to");
  if (!to || !/^\+[1-9][0-9]{7,14}$/.test(to)) {
    console.error("Required: --to <E.164 destination>");
    process.exit(2);
  }
  if (!process.env.TELNYX_API_KEY) {
    console.error("TELNYX_API_KEY missing (repo-root .env)");
    process.exit(2);
  }
  const profile = intlAlphaProfileId();
  if (!profile) {
    console.error(
      "TELNYX_INTL_ALPHA_PROFILE_ID is not set. This smoke runs POST-activation " +
        "only (PRDs/alpha-sender-rollout.md); with the env unset the alpha route " +
        "does not exist and there is nothing to prove."
    );
    process.exit(2);
  }
  const country = smsDestinationCountry(to);
  if (!isInternationalSmsDestination(country)) {
    console.error(`${to} resolves to ${country}: domestic. The alpha sender never carries US/CA traffic.`);
    process.exit(2);
  }

  const text = `New Coworker alpha sender test (${new Date().toISOString()}).\n\n${ALPHA_NO_REPLY_LINE}`;
  console.log(`Destination : ${to} (${country})`);
  console.log(`Profile     : ${profile}`);
  if (!APPLY) {
    console.log("\n[dry-run] Would send the test text and verify the sender identity. Re-run with --apply.");
    return;
  }

  const send = await telnyx("/messages", {
    method: "POST",
    body: JSON.stringify({ to, text, messaging_profile_id: profile })
  });
  if (send.status !== 200 && send.status !== 202) {
    console.error(`Send REFUSED: ${send.status} ${JSON.stringify(send.body).slice(0, 400)}`);
    console.error("(An unregistered sender or destination country typically refuses here.)");
    process.exit(1);
  }
  const id = send.body?.data?.id;
  console.log(`Accepted: message ${id}`);

  // Read back until the sender identity and cost materialize.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await sleep(3000);
    const msg = await telnyx(`/messages/${id}`);
    const data = msg.body?.data ?? {};
    const fromRaw = data.from?.phone_number ?? data.from ?? null;
    const status = data.to?.[0]?.status ?? "unknown";
    const cost = data.cost?.amount ?? null;
    const parts = data.parts ?? null;
    console.log(
      `  [${attempt}] status=${status} from=${JSON.stringify(fromRaw)} parts=${parts} cost=${cost}`
    );
    if (fromRaw && String(fromRaw).startsWith("+")) {
      console.error(
        "\nFAIL: the message left with a PHONE NUMBER as its sender, not the alpha " +
          "identity. The alpha route was not taken; do not trust this channel until " +
          "the profile/registration is sorted with Telnyx."
      );
      process.exit(1);
    }
    if (fromRaw && !String(fromRaw).startsWith("+")) {
      console.log(`\nOK: sender identity is "${fromRaw}" (alpha).`);
      if (cost !== null) {
        console.log(
          `Billing evidence: parts=${parts}, cost=${cost} ${data.cost?.currency ?? ""}. ` +
            "Compare against the deck rate to settle per-message vs per-part."
        );
      } else {
        console.log("Cost not materialized yet; re-read this message id later for the billing answer.");
      }
      return;
    }
  }
  console.error("\nFAIL: sender identity never materialized in 30s; read the message id manually.");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
