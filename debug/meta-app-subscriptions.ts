/**
 * Reconcile the APP-LEVEL webhook field subscriptions with what the code
 * actually handles.
 *
 *   npx tsx debug/meta-app-subscriptions.ts           # dry run
 *   npx tsx debug/meta-app-subscriptions.ts --apply
 *
 * WHY THIS EXISTS, and it is the trap worth knowing: Meta has TWO
 * subscription layers and delivers a field only when BOTH are set.
 *
 *   1. APP level, this script:  POST /{app-id}/subscriptions
 *      "which fields does this APP want, per object"
 *   2. PAGE level, meta-resubscribe-pages.ts:
 *      POST /{page_id}/subscribed_apps
 *      "which fields does THIS PAGE send to the app"
 *
 * Adding a field to META_PAGE_SUBSCRIBED_FIELDS and re-subscribing every Page
 * therefore does NOTHING on its own: the app is not asking for the field, so
 * Meta sends nothing and the new handler sits there receiving no deliveries.
 * That is exactly what happened with `feed`, `messaging_referrals`,
 * `message_echoes`, `live_comments`, and `message_template_status_update`:
 * all shipped, all page-subscribed, none delivered.
 *
 * The `instagram` and `whatsapp_business_account` objects have NO page-level
 * step at all, so for them this script is the only subscription that exists.
 *
 * SAFETY: POSTing a field list REPLACES the object's list. This script reads
 * the current fields first and writes their UNION with the wanted ones, so a
 * field somebody added in the dashboard is never silently dropped.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const apply = process.argv.includes("--apply");

/**
 * What each object must be subscribed to for the handlers in
 * src/lib/meta/webhook.ts to receive anything. Keep in step with the parser:
 * a field here that nothing handles is noise, and a handler whose field is
 * missing here is dead code.
 */
const WANTED: Record<string, string[]> = {
  page: [
    "leadgen", // Lead Ads
    "messages", // Messenger DMs
    "messaging_postbacks", // button taps
    "feed", // comments on the Page's own posts
    "messaging_referrals", // Click-to-Messenger ad attribution
    "message_echoes" // a human replying in Meta's Page Inbox
  ],
  instagram: [
    "messages", // IG DMs
    "messaging_postbacks",
    "comments", // comments on IG posts
    "live_comments" // comments during an IG Live
  ],
  whatsapp_business_account: [
    "messages", // inbound WhatsApp
    "message_template_status_update" // a template paused/rejected/reinstated
  ]
};

async function main() {
  const appId = (process.env.META_APP_ID ?? "").trim();
  const appSecret = (process.env.META_APP_SECRET ?? "").trim();
  const verifyToken = (process.env.META_WEBHOOK_VERIFY_TOKEN ?? "").trim();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!appId || !appSecret) throw new Error("META_APP_ID / META_APP_SECRET are required");
  if (!verifyToken) throw new Error("META_WEBHOOK_VERIFY_TOKEN is required");
  if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL is required");

  const { META_GRAPH_BASE_URL } = await import("../src/lib/meta/client.ts");
  const appToken = `${appId}|${appSecret}`;
  const callbackUrl = `${appUrl}/api/webhooks/meta`;

  const read = async () => {
    const url = new URL(`${META_GRAPH_BASE_URL}/${appId}/subscriptions`);
    url.searchParams.set("access_token", appToken);
    const body = (await (await fetch(url)).json()) as {
      data?: { object: string; fields?: (string | { name?: string })[]; callback_url?: string }[];
      error?: { message?: string };
    };
    if (body.error) throw new Error(`read subscriptions: ${body.error.message}`);
    const map = new Map<string, string[]>();
    for (const row of body.data ?? []) {
      map.set(
        row.object,
        (row.fields ?? []).map((f) => (typeof f === "string" ? f : (f.name ?? ""))).filter(Boolean)
      );
    }
    return map;
  };

  const current = await read();
  console.log(`callback: ${callbackUrl}\n`);

  let changed = 0;
  for (const [object, wanted] of Object.entries(WANTED)) {
    const have = current.get(object) ?? [];
    const missing = wanted.filter((f) => !have.includes(f));
    // UNION, never a replacement: a field added in the dashboard that this
    // script does not know about must survive.
    const next = [...new Set([...have, ...wanted])].sort();

    console.log(`${object}`);
    console.log(`  now:     ${have.sort().join(", ") || "(none)"}`);
    if (missing.length === 0) {
      console.log(`  missing: (none)\n`);
      continue;
    }
    console.log(`  missing: ${missing.join(", ")}`);
    if (!apply) {
      console.log(`  would set: ${next.join(", ")}\n`);
      continue;
    }

    const url = new URL(`${META_GRAPH_BASE_URL}/${appId}/subscriptions`);
    url.searchParams.set("object", object);
    url.searchParams.set("callback_url", callbackUrl);
    url.searchParams.set("fields", next.join(","));
    url.searchParams.set("verify_token", verifyToken);
    url.searchParams.set("access_token", appToken);
    const res = await fetch(url, { method: "POST" });
    const payload = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: { message?: string };
    } | null;
    if (!res.ok || payload?.success !== true) {
      console.log(`  FAILED: ${payload?.error?.message ?? `HTTP ${res.status}`}\n`);
      continue;
    }
    changed += 1;
    console.log(`  set:     ${next.join(", ")}\n`);
  }

  if (apply) {
    // Read back rather than trusting the write: Meta answers success:true
    // before the change is necessarily reflected.
    const after = await read();
    console.log("--- verification ---");
    let ok = true;
    for (const [object, wanted] of Object.entries(WANTED)) {
      const have = after.get(object) ?? [];
      const stillMissing = wanted.filter((f) => !have.includes(f));
      console.log(`  ${object}: ${stillMissing.length === 0 ? "OK" : `MISSING ${stillMissing.join(", ")}`}`);
      if (stillMissing.length > 0) ok = false;
    }
    console.log(ok ? "\nAll wanted fields are subscribed." : "\nSome fields did NOT take.");
    console.log(`${changed} object(s) updated.`);
    if (ok) {
      console.log(
        "\nPage-level subscriptions are a SEPARATE step: run\n" +
          "  npx tsx debug/meta-resubscribe-pages.ts --apply\n" +
          "for the `page` object. instagram and whatsapp_business_account have no page-level step."
      );
    }
  } else {
    console.log("Dry run. Re-run with --apply to write.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
