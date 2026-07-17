/**
 * Read-only tenant-box verification over pinned SSH: voice-bridge env caps
 * (session max, Gemini Live / transcription toggles), container status,
 * bridge :8090 health, and free memory.
 *
 * Defaults to the New Coworker (HQ, internal) tenant; pass a businessId to
 * check another box.
 *
 * Usage: tsx debug/box-verify.ts [businessId]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const businessId = process.argv[2] ?? HQ_BUSINESS_ID;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExecPinned } = await import("../src/lib/hostinger/ssh-pinned.ts");

const key = await getActiveVpsSshKeyForBusiness(businessId);
if (!key) throw new Error(`no active ssh key row for business ${businessId}`);
const ip = await resolveVpsIp(makeHostingerClient(), key);
console.log("box ip:", ip);

const res = await sshExecPinned(key, {
  host: ip,
  port: 22,
  username: key.ssh_username,
  privateKeyPem: key.private_key_pem,
  command: [
    "grep -E '^(GEMINI_LIVE_SESSION_MAX_MS|GEMINI_LIVE_ENABLED|VOICE_TRANSCRIPTION_ENABLED|BRIDGE_MEDIA_WSS_ORIGIN|BUSINESS_ID)=' /opt/voice-bridge/.env",
    "docker ps --format '{{.Names}} {{.Status}}'",
    "curl -s -o /dev/null -w 'bridge http %{http_code}\\n' http://127.0.0.1:8090/",
    "free -m | head -2"
  ].join(" && echo --- && ")
});
console.log(res.stdout);
if (res.exitCode !== 0) console.error("exit", res.exitCode, res.stderr);
