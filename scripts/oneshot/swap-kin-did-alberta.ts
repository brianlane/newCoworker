/**
 * swap-kin-did-alberta.ts: replace KIN Integrated Child Health's coworker
 * number with an Alberta one before it gets published anywhere.
 *
 * Provisioning bought +1 519 (southwestern Ontario) because
 * `preferred_area_code` was null at signup and the CA search took what the
 * inventory had. The clinic is in Edmonton: ads audiences in 780-land answer
 * 780/825/587 numbers better, and swapping is only cheap while the number is
 * unpublished (Meta ads launch imminently). Search order 780 (classic
 * Edmonton), then 825 (Edmonton/Calgary overlay), then 587 (Alberta-wide).
 *
 * Reuses the provisioning path (`orderAndAssignDidForBusiness`), which
 * orders the number pre-attached to KIN's existing Call Control connection
 * and Messaging Profile, upserts business_telnyx_settings + the voice route,
 * then this script:
 *   - restores `forward_to_e164` if the assign recomputed it (the owner set
 *     a specific transfer number at intake; clobbering it would re-route
 *     warm transfers to the wrong phone),
 *   - deletes the stale voice route for the OLD number (routes are keyed by
 *     to_e164, so the upsert for the new DID leaves the old row behind),
 *   - releases the old number at Telnyx, ending its rental. Release is NOT
 *     undoable, so it happens last, only after the new assignment verified.
 *
 * Usage:
 *   npx tsx scripts/oneshot/swap-kin-did-alberta.ts --business <uuid>          # dry-run: searches + prints plan
 *   npx tsx scripts/oneshot/swap-kin-did-alberta.ts --business <uuid> --apply
 *   optional: --area 780   (skip the cascade, force one NPA)
 *             --keep-old   (skip the Telnyx release of the old number)
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const KEEP_OLD = process.argv.includes("--keep-old");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.KIN_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KIN_BUSINESS_ID)");
  process.exit(1);
}
const areaArgIdx = process.argv.indexOf("--area");
const FORCED_AREA = areaArgIdx !== -1 ? process.argv[areaArgIdx + 1] : null;
const AREA_CASCADE = FORCED_AREA ? [FORCED_AREA] : ["780", "825", "587"];

const { createClient } = await import("@supabase/supabase-js");
const { TelnyxNumbersClient } = await import("../../src/lib/telnyx/numbers.ts");
const { orderAndAssignDidForBusiness } = await import("../../src/lib/telnyx/assign-did.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const apiKey = process.env.TELNYX_API_KEY ?? "";
if (!apiKey) {
  console.error("[oneshot] TELNYX_API_KEY missing from env");
  process.exit(1);
}
const telnyxNumbers = new TelnyxNumbersClient({ apiKey });
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: before, error: beforeErr } = await db
  .from("business_telnyx_settings")
  .select("*")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
if (beforeErr || !before) {
  console.error(`[oneshot] settings fetch failed: ${beforeErr?.message ?? "no row"}`);
  process.exit(1);
}
const oldDid: string = before.telnyx_sms_from_e164;
const ownerForward: string | null = before.forward_to_e164;
console.log(`[oneshot] current DID ${oldDid}, forward_to ${ownerForward}, connection ${before.telnyx_connection_id}, profile ${before.telnyx_messaging_profile_id}`);
if (!/^\+1519/.test(oldDid)) {
  console.log("[oneshot] current DID is not a 519 number; nothing to swap. Exiting.");
  process.exit(0);
}

// Find inventory before touching anything, so the dry-run answer is real.
let chosenArea: string | null = null;
let sample: string[] = [];
for (const area of AREA_CASCADE) {
  const found = await telnyxNumbers.searchAvailable({
    countryCode: "CA",
    areaCode: area,
    features: ["sms", "voice"],
    limit: 5
  });
  console.log(`[oneshot] ${area}: ${found.length} available${found.length ? ", e.g. " + found.slice(0, 3).map((n) => n.phone_number).join(", ") : ""}`);
  if (found.length > 0 && !chosenArea) {
    chosenArea = area;
    sample = found.map((n) => n.phone_number);
  }
}
if (!chosenArea) {
  console.error("[oneshot] no Alberta inventory in any of: " + AREA_CASCADE.join(", "));
  process.exit(1);
}
console.log(`[oneshot] plan: order one ${chosenArea} number (${sample[0]}), assign, ${KEEP_OLD ? "KEEP" : "release"} ${oldDid}`);

if (!APPLY) {
  console.log("[oneshot] dry-run only. Re-run with --apply to write.");
  process.exit(0);
}

const result = await orderAndAssignDidForBusiness(
  {
    businessId: BUSINESS_ID,
    platformDefaults: {
      connectionId: before.telnyx_connection_id ?? undefined,
      messagingProfileId: before.telnyx_messaging_profile_id ?? undefined,
      bridgeMediaWssOrigin: before.bridge_media_wss_origin ?? undefined
    },
    search: { countryCode: "CA", areaCode: chosenArea, features: ["sms", "voice"] }
  },
  { telnyxNumbers }
);
const newDid = result.settings.telnyx_sms_from_e164;
console.log(`[oneshot] assigned ${newDid} (order ${result.orderId}); route -> ${result.route.to_e164}`);

// The assign path recomputes a default forward number; the intake set a
// specific one. Put the owner's value back if it moved.
if (ownerForward && result.settings.forward_to_e164 !== ownerForward) {
  const { error } = await db
    .from("business_telnyx_settings")
    .update({ forward_to_e164: ownerForward })
    .eq("business_id", BUSINESS_ID);
  if (error) {
    console.error(`[oneshot] forward_to restore FAILED: ${error.message}; restore by hand to ${ownerForward}`);
  } else {
    console.log(`[oneshot] forward_to restored to ${ownerForward}`);
  }
}

// Voice routes are keyed by to_e164; drop the old number's row.
const { error: routeErr } = await db.from("telnyx_voice_routes").delete().eq("to_e164", oldDid);
console.log(routeErr ? `[oneshot] old route delete failed: ${routeErr.message}` : `[oneshot] old route ${oldDid} removed`);

if (!KEEP_OLD) {
  try {
    await telnyxNumbers.deletePhoneNumber(oldDid);
    console.log(`[oneshot] released ${oldDid} at Telnyx (rental ended)`);
  } catch (err) {
    console.error(
      `[oneshot] RELEASE FAILED for ${oldDid}: ${err instanceof Error ? err.message : String(err)}. ` +
        "The new number is live; release the old one from the Telnyx portal to stop its rental."
    );
  }
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: { oldDid, newDid, area: chosenArea, orderId: result.orderId ?? null, releasedOld: !KEEP_OLD }
});
console.log(`[oneshot] done: ${oldDid} -> ${newDid}`);
