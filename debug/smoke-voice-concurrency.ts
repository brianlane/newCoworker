/**
 * Voice-bridge CONCURRENCY smoke test.
 *
 * Opens N simultaneous fake-Telnyx media streams against a tenant VPS's
 * voice-bridge (default 3 — the standard tier's maxConcurrentCalls), each of
 * which makes the bridge spin up a REAL Gemini Live session (vault priming,
 * greeting, two-way audio pipeline), and reports per-call frame throughput.
 * This is the hardware-contention half of the concurrency question: the
 * entitlement gate lives in telnyx-voice-inbound (VOICE_RES_LIMITS), but only
 * a live test shows whether a KVM2 box can actually sustain the sessions.
 *
 * What it does per call:
 *   1. mints a stream nonce (INSERT into `stream_url_nonces`) and signs a v2
 *      stream URL with STREAM_URL_SIGNING_SECRET — exactly what
 *      telnyx-voice-inbound does before handing the URL to Telnyx;
 *   2. connects to ws://<vps>:8090/voice/stream and streams 20 ms L16@16kHz
 *      silence frames at real-time cadence (Telnyx `{event:"media"}` JSON);
 *   3. counts downlink media frames (the Gemini greeting proves audio is
 *      flowing back) and reports frames/bytes/close codes at the end.
 *
 * ⚠️ Uses REAL Gemini Live sessions (small spend on the tenant's shared AI
 * budget) and writes transcript/telemetry rows for the target business —
 * point it at a scratch clone (default: the KVM2 smoke clone), not a live
 * tenant. The bridge's end-of-session Telnyx hangup 404s harmlessly on the
 * fake call_control_ids.
 *
 * Usage:
 *   tsx debug/smoke-voice-concurrency.ts [--business <uuid>] [--calls 3]
 *     [--duration-s 75] [--ip <vps-ip>]
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv, makeHostingerClient } from "./_shared.ts";
import { signStreamUrlPayload, newStreamNonce } from "../src/lib/telnyx/stream-url.ts";

loadEnv();

// New Coworker (HQ, internal) — the smoke tenants/clones are retired; the
// spend + transcript rows this writes land on our own tenant by default.
const DEFAULT_BUSINESS = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const businessId = arg("business") ?? DEFAULT_BUSINESS;
const calls = Math.max(1, Math.min(40, Number(arg("calls") ?? "3")));
const durationS = Math.max(15, Math.min(600, Number(arg("duration-s") ?? "75")));

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const STREAM_SECRET = process.env.STREAM_URL_SIGNING_SECRET ?? "";
if (!SUPABASE_URL || !SERVICE_KEY || !STREAM_SECRET) {
  console.error("need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STREAM_URL_SIGNING_SECRET in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// 20 ms of L16 @ 16 kHz silence = 320 samples * 2 bytes. Silence keeps Gemini
// in listen mode (greeting still fires) while exercising the full uplink
// decode → resample → peak-scan path at the real per-call CPU cost.
const SILENCE_FRAME = Buffer.alloc(640).toString("base64");
const FRAME_MSG = JSON.stringify({ event: "media", media: { payload: SILENCE_FRAME } });

type CallStats = {
  id: string;
  connected: boolean;
  uplinkFrames: number;
  downlinkFrames: number;
  downlinkBytes: number;
  firstDownlinkMs: number | null;
  closeCode: number | null;
  error: string | null;
};

async function resolveIp(): Promise<string> {
  const fromArg = arg("ip");
  if (fromArg) return fromArg;
  // The smoke clone accumulated key rows across provisioning rounds — take
  // the newest, which is the box the tunnel currently points at.
  const { data: keyRow, error } = await supabase
    .from("vps_ssh_keys")
    .select("hostinger_vps_id")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !keyRow?.hostinger_vps_id) {
    throw new Error(`no vps_ssh_keys row for ${businessId}: ${error?.message ?? "missing"}`);
  }
  const vm = await makeHostingerClient().getVirtualMachine(Number(keyRow.hostinger_vps_id));
  const ip = vm.ipv4?.[0]?.address;
  if (!ip) throw new Error(`no IPv4 for vps ${keyRow.hostinger_vps_id}`);
  return ip;
}

async function resolveToE164(): Promise<string> {
  const { data } = await supabase
    .from("telnyx_voice_routes")
    .select("to_e164")
    .eq("business_id", businessId)
    .maybeSingle();
  const did = (data as { to_e164?: string | null } | null)?.to_e164;
  return did && did.startsWith("+") ? did : "+15555550100";
}

async function runCall(ip: string, toE164: string, idx: number, endAtMs: number): Promise<CallStats> {
  const callControlId = `smoke-conc-${Date.now()}-${idx}`;
  const stats: CallStats = {
    id: callControlId,
    connected: false,
    uplinkFrames: 0,
    downlinkFrames: 0,
    downlinkBytes: 0,
    firstDownlinkMs: null,
    closeCode: null,
    error: null
  };

  const nonce = newStreamNonce();
  const exp = Math.floor(Date.now() / 1000) + 110;
  const { error: nonceErr } = await supabase.from("stream_url_nonces").insert({
    nonce,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString()
  });
  if (nonceErr) {
    stats.error = `nonce insert: ${nonceErr.message}`;
    return stats;
  }

  const mac = signStreamUrlPayload(
    { v: 2, call_control_id: callControlId, business_id: businessId, to_e164: toE164, from_e164: "", exp, nonce },
    STREAM_SECRET
  );
  const qs = new URLSearchParams({
    v: "2",
    call_control_id: callControlId,
    business_id: businessId,
    to_e164: toE164,
    from_e164_info: "",
    exp: String(exp),
    nonce,
    mac
  });
  const url = `ws://${ip}:8090/voice/stream?${qs.toString()}`;

  await new Promise<void>((resolve) => {
    const startedAt = Date.now();
    let sender: ReturnType<typeof setInterval> | null = null;
    const ws = new WebSocket(url);

    const finish = (): void => {
      if (sender) clearInterval(sender);
      sender = null;
      resolve();
    };

    ws.onopen = () => {
      stats.connected = true;
      console.log(`[call ${idx}] connected (${callControlId})`);
      sender = setInterval(() => {
        if (Date.now() >= endAtMs) {
          try {
            ws.close(1000);
          } catch {
            /* already closing */
          }
          return;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(FRAME_MSG);
          stats.uplinkFrames += 1;
        }
      }, 20);
    };
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw.includes('"media"')) return;
      stats.downlinkFrames += 1;
      stats.downlinkBytes += raw.length;
      if (stats.firstDownlinkMs === null) {
        stats.firstDownlinkMs = Date.now() - startedAt;
        console.log(`[call ${idx}] first downlink audio after ${stats.firstDownlinkMs} ms`);
      }
    };
    ws.onerror = () => {
      stats.error = stats.error ?? "ws error";
    };
    ws.onclose = (ev) => {
      stats.closeCode = ev.code;
      finish();
    };
  });

  return stats;
}

const ip = await resolveIp();
const toE164 = await resolveToE164();
console.log(
  `voice concurrency smoke: ${calls} calls x ${durationS}s -> ws://${ip}:8090 (business ${businessId}, to ${toE164})`
);

const endAtMs = Date.now() + durationS * 1000;
const results = await Promise.all(
  Array.from({ length: calls }, (_, i) => runCall(ip, toE164, i, endAtMs))
);

console.log("\n=== results ===");
let ok = true;
for (const r of results) {
  const line =
    `${r.id}: connected=${r.connected} uplink=${r.uplinkFrames} ` +
    `downlink=${r.downlinkFrames} (${Math.round(r.downlinkBytes / 1024)} KiB) ` +
    `firstAudioMs=${r.firstDownlinkMs ?? "never"} close=${r.closeCode} err=${r.error ?? "none"}`;
  console.log(line);
  // Pass bar: the connection held and the Gemini greeting made it back out.
  if (!r.connected || r.downlinkFrames === 0) ok = false;
}
console.log(ok ? "\nPASS: all calls streamed two-way audio concurrently" : "\nFAIL: see per-call stats");
process.exit(ok ? 0 : 1);
