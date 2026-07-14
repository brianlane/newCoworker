/**
 * Rowboat scheduling-tools reseed (appointment reschedule/cancel, PR "Truly
 * Issue 4").
 *
 * Retrofits already-provisioned tenants' Rowboat projects with the new
 * appointment-lifecycle tools:
 *
 *   - texting coworker (Coworker/CoworkerLocal) gains
 *     calendar_reschedule_appointment, calendar_cancel_appointment
 *   - dashboard coworker (OwnerCoworker/OwnerCoworkerLocal) gains the
 *     dashboard_ twins
 *
 * Both execute through the platform dispatcher (/api/rowboat/tool-call) and
 * are gated per surface by agent_tool_settings. Surgical Mongo patch over
 * pinned SSH — idempotent; re-running converges and never duplicates
 * declarations. deploy-client.sh seeds all of this for NEW tenants; this
 * script exists for boxes provisioned before the tools shipped.
 *
 * Usage: tsx debug/reseed-scheduling-tools.ts [businessId]
 *        tsx debug/reseed-scheduling-tools.ts --all
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const flags = process.argv.slice(2);
const ALL = flags.includes("--all");
const args = flags.filter((a) => !a.startsWith("--"));
const SINGLE_BUSINESS_ID = args[0] ?? "";

const remote = `
set -uo pipefail
DC="docker compose -f /opt/rowboat/docker-compose.yml"

cat > /tmp/reseed-scheduling.js <<'JS_EOF'
function rescheduleParams(who) {
  return {
    type: "object",
    properties: {
      newStartIso: { type: "string", description: "New start time, ISO 8601 with offset." },
      newEndIso: { type: "string", description: "New end time, ISO 8601 with offset." },
      attendeePhone: { type: "string", description: who + " phone the appointment was booked under (E.164)." },
      attendeeEmail: { type: "string", description: who + " email, if the phone is unknown." },
      attendeeName: { type: "string", description: who + " name, if known." },
      timezone: { type: "string", description: "IANA timezone for the new times." }
    },
    required: ["newStartIso", "newEndIso"]
  };
}
function cancelParams(who) {
  return {
    type: "object",
    properties: {
      attendeePhone: { type: "string", description: who + " phone the appointment was booked under (E.164)." },
      attendeeEmail: { type: "string", description: who + " email, if the phone is unknown." },
      attendeeName: { type: "string", description: who + " name, if known." }
    },
    required: []
  };
}
var NEW_TOOLS = [
  {
    name: "calendar_reschedule_appointment",
    description: "Move the customer existing upcoming appointment to a new time. The SAME event is updated in place and the customer receives an UPDATED invitation - this is the ONLY way to change an appointment time. NEVER book a second appointment to change a time. Confirm the new time with the customer before calling. Times must be ISO 8601 with timezone offset.",
    isWebhook: true,
    parameters: rescheduleParams("Customer")
  },
  {
    name: "calendar_cancel_appointment",
    description: "Cancel the customer existing upcoming appointment. The event is deleted and the customer receives ONE cancellation notice. Only call when the customer clearly asks to cancel; confirm before calling. This is the ONLY way an appointment gets canceled - never just say it is canceled.",
    isWebhook: true,
    parameters: cancelParams("Customer")
  },
  {
    name: "dashboard_calendar_reschedule_appointment",
    description: "Move an existing upcoming appointment to a new time when the owner asks in dashboard chat. The SAME event is updated in place - never book a second appointment to change a time. Times must be ISO 8601 with timezone offset.",
    isWebhook: true,
    parameters: rescheduleParams("Attendee")
  },
  {
    name: "dashboard_calendar_cancel_appointment",
    description: "Cancel an existing upcoming appointment when the owner asks in dashboard chat. The event is deleted and the attendee receives ONE cancellation notice.",
    isWebhook: true,
    parameters: cancelParams("Attendee")
  }
];
var AGENT_TOOLS = {
  Coworker: ["calendar_reschedule_appointment", "calendar_cancel_appointment"],
  CoworkerLocal: ["calendar_reschedule_appointment", "calendar_cancel_appointment"],
  OwnerCoworker: ["dashboard_calendar_reschedule_appointment", "dashboard_calendar_cancel_appointment"],
  OwnerCoworkerLocal: ["dashboard_calendar_reschedule_appointment", "dashboard_calendar_cancel_appointment"]
};
function patch(wf) {
  if (!wf) return false;
  var changed = false;
  if (Array.isArray(wf.tools)) {
    NEW_TOOLS.forEach(function (def) {
      if (!wf.tools.some(function (t) { return t.name === def.name; })) {
        wf.tools.push(def);
        changed = true;
      }
    });
  }
  if (Array.isArray(wf.agents)) {
    wf.agents.forEach(function (a) {
      var add = AGENT_TOOLS[a.name];
      if (!add) return;
      a.tools = a.tools || [];
      add.forEach(function (name) {
        if (a.tools.indexOf(name) === -1) { a.tools.push(name); changed = true; }
      });
    });
  }
  return changed;
}
var n = 0, updated = 0;
db.projects.find({}).forEach(function (p) {
  n++;
  var changed = false;
  if (patch(p.liveWorkflow)) changed = true;
  if (patch(p.draftWorkflow)) changed = true;
  if (changed) {
    db.projects.updateOne({ _id: p._id }, { $set: {
      liveWorkflow: p.liveWorkflow,
      draftWorkflow: p.draftWorkflow
    }});
    updated++;
  }
});
print(JSON.stringify({ projects: n, updated: updated }));
JS_EOF

echo "===APPLY==="
\$DC cp /tmp/reseed-scheduling.js mongo:/tmp/reseed-scheduling.js >/dev/null
\$DC exec -T mongo mongosh --quiet rowboat /tmp/reseed-scheduling.js 2>/dev/null || { echo "ERR applying"; exit 1; }

echo "===VERIFY==="
\$DC exec -T mongo mongosh --quiet rowboat --eval '
db.projects.find({}).forEach(function(p){
  var wf = p.liveWorkflow || {};
  var names = (wf.tools || []).map(function(t){ return t.name; });
  print(p._id + "  reschedule=" + (names.indexOf("calendar_reschedule_appointment") !== -1) + " cancel=" + (names.indexOf("calendar_cancel_appointment") !== -1));
});' 2>/dev/null || echo "ERR verify"
echo "===DONE==="
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExecPinned } = await import("../src/lib/hostinger/ssh-pinned.ts");

async function targetBusinessIds(): Promise<string[]> {
  if (!ALL) {
    if (!SINGLE_BUSINESS_ID) {
      throw new Error("usage: tsx debug/reseed-scheduling-tools.ts <businessId> | --all");
    }
    return [SINGLE_BUSINESS_ID];
  }
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { persistSession: false } }
  );
  const { data, error } = await db
    .from("businesses")
    .select("id, name, status")
    .neq("status", "wiped")
    .not("hostinger_vps_id", "is", null);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string; status: string }>)
    .filter((b) => b.status === "online")
    .map((b) => b.id);
}

const client = makeHostingerClient();
let failures = 0;
for (const businessId of await targetBusinessIds()) {
  console.log(`\n== Rowboat scheduling-tools reseed: ${businessId} ==`);
  const key = await getActiveVpsSshKeyForBusiness(businessId);
  if (!key) {
    console.error(`no active ssh key for business ${businessId} — skipping`);
    failures += 1;
    continue;
  }
  const ip = await resolveVpsIp(client, key);
  console.log(`vps=${ip}`);
  try {
    const res = await sshExecPinned(key, {
      host: ip,
      username: key.ssh_username || "root",
      privateKeyPem: key.private_key_pem,
      command: remote,
      timeoutMs: 5 * 60 * 1000,
      onStdout: (c: string) => process.stdout.write(c),
      onStderr: (c: string) => process.stderr.write(c)
    });
    console.log(`\n[reseed] exit ${res.exitCode}`);
    if (res.exitCode !== 0) failures += 1;
  } catch (err) {
    console.error(`[reseed] ${businessId} failed:`, err instanceof Error ? err.message : err);
    failures += 1;
  }
}
process.exit(failures === 0 ? 0 : 1);
