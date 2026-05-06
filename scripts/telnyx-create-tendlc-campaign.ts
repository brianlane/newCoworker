#!/usr/bin/env tsx
/**
 * One-shot script: submit our shared 10DLC (A2P SMS) campaign on top of an
 * already-registered Telnyx brand. After this returns successfully, set
 * `TELNYX_10DLC_CAMPAIGN_ID` to the printed campaign id in `.env` and
 * (via `vercel env add`) in production. From that point onward the
 * provisioning orchestrator + the dashboard banner take over.
 *
 * Why one-shot:
 *   Telnyx charges a non-refundable 3-month upfront fee at submit time,
 *   so this is intentionally NOT wired into automated CI / migration runs
 *   — it requires deliberate human invocation.
 *
 * Idempotency:
 *   The script first lists existing campaigns for the brand and refuses
 *   to submit a duplicate. Re-runs are safe; the second invocation prints
 *   the already-existing campaign and exits 0. Pass `--force` only when
 *   you genuinely want a SECOND campaign on the same brand (rare — the
 *   shared-campaign / many-numbers pattern is enough up to 49 DIDs per
 *   campaign).
 *
 * Usage:
 *   TELNYX_API_KEY=KEY… \
 *   TELNYX_10DLC_BRAND_ID=4b20019d-… \
 *     npx tsx scripts/telnyx-create-tendlc-campaign.ts            # default: print + submit
 *   TELNYX_API_KEY=… npx tsx scripts/telnyx-create-tendlc-campaign.ts --dry-run
 *
 * Exit codes:
 *   0  — campaign exists or was submitted successfully
 *   1  — Telnyx returned an error (insufficient funds, validation, etc)
 *   2  — required env missing
 */

import {
  TendlcClient,
  TendlcApiError,
  type TendlcCampaignSubmit
} from "@/lib/telnyx/tendlc";

type Args = { dryRun: boolean; force: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, force: false };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function buildPayload(brandId: string): TendlcCampaignSubmit {
  // CUSTOMER_CARE has the lowest carrier fees and accurately describes our
  // workload (AI customer-service assistant for SMBs). MIXED would cost
  // more without buying us anything we'd actually use.
  return {
    brandId,
    usecase: "CUSTOMER_CARE",
    description:
      "Newcoworker is an AI customer-service assistant for small business owners. " +
      "After a customer initiates contact by texting the business's published phone number, " +
      "our AI replies on behalf of the business to answer questions about products, hours, " +
      "scheduling, and routing — across industries including local services, retail, healthcare, " +
      "real estate, fitness, and professional services. Two-way conversational; STOP supported.",
    messageFlow:
      "Customers initiate every conversation by texting the small-business owner's published " +
      "phone number, which the business owner advertises on their website or storefront. " +
      "The AI responds during business hours and escalates to the business owner when needed. " +
      "Customers may reply STOP at any time to opt out. The customer-supplied phone number is " +
      "never shared with third parties or used for marketing.",
    helpMessage:
      "Newcoworker: For help, contact the business you texted, or reply with your question. " +
      "Msg&data rates may apply. Reply STOP to opt out.",
    optinMessage:
      "You're subscribed to Newcoworker SMS for this number. Reply STOP to opt out. " +
      "Msg&data rates may apply.",
    optoutMessage:
      "You're opted out of Newcoworker SMS for this number. " +
      "You may still receive transactional messages.",
    optinKeywords: "START,YES,UNSTOP",
    optoutKeywords: "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT",
    helpKeywords: "HELP",
    // Industry-agnostic samples — Path A small-business assistant covering
    // services, scheduling, pricing, transactional confirms, and inbound
    // photo-collection. All include STOP language per CTIA guidelines.
    sample1:
      "Hi! Thanks for reaching out to Riverside Plumbing. We're booked through Friday, " +
      "but we have an opening Saturday at 10 AM. Would that work for you? Reply STOP to opt out.",
    sample2:
      "Yes, we accept walk-ins from 8 AM-5 PM Mon-Fri. Want me to ping the team you're on " +
      "the way? Msg&data rates apply. STOP to opt out.",
    sample3:
      "Thanks for the inquiry! Our hourly rate is $85. I'll have Sarah call you back within " +
      "the hour to confirm the visit. Reply STOP to opt out.",
    sample4:
      "Got it — your appointment is set for Tue 2:30 PM. We'll send a reminder the morning " +
      "of. Reply STOP to opt out.",
    sample5:
      "Sorry to hear about the leak. Can you send a photo so we can quote accurately? Or " +
      "call us at the same number. STOP to opt out.",
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    embeddedLink: false,
    embeddedPhone: false,
    numberPool: false,
    ageGated: false,
    directLending: false,
    affiliateMarketing: false
  };
}

async function listExistingCampaigns(
  apiKey: string,
  brandId: string
): Promise<Array<{ campaignId: string; status?: string; usecase?: string }>> {
  // The TendlcClient doesn't wrap the list endpoint (we only need it from
  // this CLI), so call it directly here.
  const url = `https://api.telnyx.com/v2/10dlc/campaign?brandId=${encodeURIComponent(brandId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`list campaigns failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    records?: Array<{ campaignId?: string; status?: string; usecase?: string }>;
  };
  return (json.records ?? []).flatMap((r) =>
    r.campaignId ? [{ campaignId: r.campaignId, status: r.status, usecase: r.usecase }] : []
  );
}

/* c8 ignore start -- this is a one-shot CLI; mainline tested manually */
async function main(): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY;
  const brandId = process.env.TELNYX_10DLC_BRAND_ID;
  if (!apiKey || !brandId) {
    console.error(
      "Missing required env: TELNYX_API_KEY and TELNYX_10DLC_BRAND_ID must be set."
    );
    process.exit(2);
  }
  const args = parseArgs(process.argv);
  const payload = buildPayload(brandId);

  console.log("=== Existing campaigns for this brand ===");
  const existing = await listExistingCampaigns(apiKey, brandId);
  for (const c of existing) {
    console.log(
      `  - ${c.campaignId}  status=${c.status ?? "?"}  usecase=${c.usecase ?? "?"}`
    );
  }
  if (existing.length > 0 && !args.force) {
    console.log(
      "\nA campaign already exists on this brand. Re-run with --force to submit ANOTHER one." +
        "\nSet TELNYX_10DLC_CAMPAIGN_ID to one of the printed ids above."
    );
    process.exit(0);
  }

  console.log("\n=== Payload ===");
  console.log(JSON.stringify(payload, null, 2));
  if (args.dryRun) {
    console.log("\nDry run — not submitting.");
    process.exit(0);
  }

  console.log(
    "\nSubmitting to Telnyx (this charges the non-refundable 3-month upfront fee)…"
  );
  const client = new TendlcClient({ apiKey, timeoutMs: 60_000 });
  try {
    const campaign = await client.createCampaign(payload);
    console.log("\n=== Campaign created ===");
    console.log(JSON.stringify(campaign, null, 2));
    console.log(
      `\nNext step:\n  echo 'TELNYX_10DLC_CAMPAIGN_ID=${campaign.campaignId}' >> .env\n  vercel env add TELNYX_10DLC_CAMPAIGN_ID production`
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof TendlcApiError) {
      console.error(
        `\nTelnyx rejected campaign submit:\n  status=${err.status}\n  body=${err.body.slice(0, 1000)}`
      );
    } else {
      console.error("\nCampaign submit failed:", err);
    }
    process.exit(1);
  }
}

void main();
/* c8 ignore stop */
