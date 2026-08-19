/**
 * verify-translator-mode.ts, read-only verification for live translator mode.
 *
 * Translator mode rests on ONE Telnyx behavior we cannot unit test: with
 * `stream_bidirectional_target_legs=both`, is the AI's injected audio actually
 * audible to BOTH parties once a warm transfer has bridged them, and does the
 * `both_tracks` fork carry both voices back? That needs two handsets and a pair
 * of human ears, so this script does everything AROUND the listening test:
 * confirms the tenant is armed, then reports exactly what the platform observed
 * on the most recent interpreted call.
 *
 *   tsx debug/verify-translator-mode.ts                     # HQ tenant
 *   tsx debug/verify-translator-mode.ts <businessId>
 *   tsx debug/verify-translator-mode.ts --since=30m
 *
 * MANUAL TEST (the part this script cannot do):
 *   1. Arm the tenant: admin business page, "Voice & SMS DID" card, check
 *      "Stay on the call as a live interpreter after a transfer", and set the
 *      owner phone to a SECOND handset you are holding.
 *   2. Redeploy the bridge so the box has this code:
 *      tsx debug/redeploy-voice-bridge.ts --business-id <uuid>
 *   3. Call the tenant DID from handset A. Speak Spanish. Ask for a human.
 *   4. Answer handset B when it rings. Then check, by ear:
 *        - does handset B hear the AI interpret?   (target_legs=both works)
 *        - does handset A hear it too?             (target_legs=both works)
 *        - does the AI hear BOTH of you?           (both_tracks works)
 *        - does it stay a relay, or start answering for you?
 *   5. Run this script. It prints the telemetry the call left behind.
 *
 * If handset B hears nothing, `both` is not honored on a transferred pair and
 * the design has to move to a Telnyx conference (see the plan's step 0). The
 * code fails safe in the meantime: the AI is still on the caller's leg, and the
 * ceiling timer detaches it.
 *
 * Read-only: no sends, no writes, no SSH. Requires SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env)");
  process.exit(1);
}

/** New Coworker (HQ, internal), the default smoke tenant (debug/README.md). */
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const businessId =
  process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : HQ_BUSINESS_ID;

function parseSince(raw: string | undefined): number {
  if (!raw) return 60 * 60 * 1000;
  const m = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!m) return 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * ms;
}

const sinceIso = new Date(Date.now() - parseSince(arg("since"))).toISOString();

/** Telemetry the translator path emits, in the order a healthy call produces them. */
const TRANSLATOR_EVENTS = [
  "voice_bridge_translator_mode_entered",
  "voice_bridge_translator_tool_refused",
  "voice_bridge_translator_cue_failed",
  "voice_bridge_translator_ceiling_reached",
  "voice_bridge_transfer_detach"
] as const;

async function main(): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false }
  });

  console.log(`\nTranslator mode verification, business ${businessId}`);
  console.log(`Window: since ${sinceIso}\n`);

  // 1. Is the tenant armed? Both halves have to be true: the column drives the
  //    answer-time target-legs parameter AND the bridge's stay-on decision.
  const { data: settings, error: sErr } = await supabase
    .from("business_telnyx_settings")
    .select(
      "translator_mode_enabled, transfer_enabled, forward_to_e164, bridge_last_heartbeat_at"
    )
    .eq("business_id", businessId)
    .maybeSingle();
  if (sErr) {
    console.error(`settings lookup failed: ${sErr.message}`);
    process.exit(1);
  }
  const s = settings as
    | {
        translator_mode_enabled?: boolean | null;
        transfer_enabled?: boolean | null;
        forward_to_e164?: string | null;
        bridge_last_heartbeat_at?: string | null;
      }
    | null;

  const armed = s?.translator_mode_enabled === true;
  const canTransfer = s?.transfer_enabled !== false && Boolean(s?.forward_to_e164);
  const hbAgeSec = s?.bridge_last_heartbeat_at
    ? Math.round((Date.now() - new Date(s.bridge_last_heartbeat_at).getTime()) / 1000)
    : null;

  console.log("Configuration");
  console.log(`  translator mode armed : ${armed ? "YES" : "no"}`);
  console.log(
    `  warm transfer usable : ${canTransfer ? "YES" : "no (needs transfer_enabled + forward_to_e164)"}`
  );
  console.log(
    `  bridge heartbeat     : ${hbAgeSec === null ? "never" : `${hbAgeSec}s ago`}`
  );
  if (!armed) {
    console.log(
      "\n  Not armed. Translator mode cannot engage: the answer-time stream is\n" +
        "  not requesting target_legs=both, so the AI could only ever be heard by\n" +
        "  the caller. Arm it on the admin business page before testing."
    );
  }
  if (armed && !canTransfer) {
    console.log(
      "\n  Armed but the AI has nobody to transfer to, so it can never reach the\n" +
        "  interpreter branch. Set the owner phone and enable warm transfer."
    );
  }

  // 2. What did the recent calls actually do?
  //
  // `telemetry_events` has no business_id COLUMN: the bridge's recordDiag puts it
  // inside `payload` (vps/voice-bridge/src/index.ts), so the tenant filter has to
  // be a jsonb path.
  const { data: events, error: eErr } = await supabase
    .from("telemetry_events")
    .select("event_type, payload, created_at")
    .eq("payload->>business_id", businessId)
    .in("event_type", TRANSLATOR_EVENTS as unknown as string[])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(200);
  if (eErr) {
    console.error(`\ntelemetry lookup failed: ${eErr.message}`);
    process.exit(1);
  }

  const rows = (events ?? []) as Array<{
    event_type: string;
    payload: Record<string, unknown> | null;
    created_at: string;
  }>;

  console.log(`\nTranslator telemetry (${rows.length} event(s))`);
  if (rows.length === 0) {
    console.log("  none in this window.");
    console.log(
      "  If you just ran the manual test and see nothing here, the AI never\n" +
        "  reached the transfer tool: check the call transcript for whether it\n" +
        "  offered a human at all, and system-logs.ts for a failed transfer."
    );
  }
  for (const r of rows) {
    const detail = r.payload ? JSON.stringify(r.payload) : "";
    console.log(`  ${r.created_at}  ${r.event_type}  ${detail}`);
  }

  const entered = rows.filter((r) => r.event_type === "voice_bridge_translator_mode_entered");
  const cueFailed = rows.filter((r) => r.event_type === "voice_bridge_translator_cue_failed");
  const detached = rows.filter((r) => r.event_type === "voice_bridge_transfer_detach");

  console.log("\nReading");
  if (entered.length > 0) {
    console.log(
      `  ${entered.length} call(s) entered translator mode. The fork stayed attached,\n` +
        "  so whether the HUMAN could hear the interpreter is the ear test in the\n" +
        "  header comment. Nothing in the database can answer that."
    );
  }
  if (cueFailed.length > 0) {
    console.log(
      `  ${cueFailed.length} call(s) failed to deliver the interpreter cue and fell back to\n` +
        "  the normal detach. That fallback is intended, but a repeat means the\n" +
        "  Live session is dropping right after the transfer: check the bridge logs."
    );
  }
  if (entered.length === 0 && detached.length > 0) {
    console.log(
      `  ${detached.length} transfer(s) detached normally with no translator entry. Expected\n` +
        "  when the tenant is not armed; unexpected if it is (the bridge may be\n" +
        "  running an older build: redeploy it)."
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
