/**
 * Rowboat marketplace-tools reseed (Settings → Coworker tools, phase 3).
 *
 * Retrofits an already-provisioned tenant's Rowboat project so EVERY worker
 * carries the full tool marketplace:
 *
 *   - texting coworker (Coworker/CoworkerLocal) gains
 *     business_knowledge_lookup, calendar_find_slots,
 *     calendar_book_appointment, send_email
 *   - dashboard coworker (OwnerCoworker/OwnerCoworkerLocal) gains
 *     dashboard_business_knowledge_lookup, dashboard_calendar_find_slots,
 *     dashboard_calendar_book_appointment
 *
 * All execute through the platform dispatcher (/api/rowboat/tool-call) and
 * are gated per surface by agent_tool_settings. Surgical Mongo patch over
 * SSH — idempotent; re-running converges and never duplicates declarations.
 *
 * deploy-client.sh seeds all of this for NEW tenants; this script exists for
 * boxes provisioned before the marketplace shipped.
 *
 * Usage: tsx debug/reseed-marketplace-tools.ts [businessId]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BUSINESS_ID = args[0] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const remote = `
set -uo pipefail
DC="docker compose -f /opt/rowboat/docker-compose.yml"

cat > /tmp/reseed-marketplace.js <<'JS_EOF'
var KNOWLEDGE_PARAMS = {
  type: "object",
  properties: {
    question: { type: "string", description: "The question to answer, in plain words." }
  },
  required: ["question"]
};
var FIND_SLOTS_PARAMS = {
  type: "object",
  properties: {
    purpose: { type: "string", description: "What the appointment is for." },
    earliest: { type: "string", description: "Earliest acceptable start, ISO 8601. Defaults to now." },
    latest: { type: "string", description: "Latest acceptable end, ISO 8601. Defaults to 7 days out." },
    durationMinutes: { type: "number", description: "Appointment length in minutes. Defaults to 30." },
    timezone: { type: "string", description: "IANA timezone, if known." }
  },
  required: []
};
function bookParams(who) {
  return {
    type: "object",
    properties: {
      startIso: { type: "string", description: "Start time, ISO 8601." },
      endIso: { type: "string", description: "End time, ISO 8601." },
      summary: { type: "string", description: "Short event title." },
      attendeeName: { type: "string", description: who + " name for the event." },
      attendeeEmail: { type: "string", description: who + " email, if provided." },
      attendeePhone: { type: "string", description: who + " phone, if known." },
      notes: { type: "string", description: "Extra context for the event description." },
      timezone: { type: "string", description: "IANA timezone for the event times." }
    },
    required: ["startIso", "endIso", "summary", "attendeeName"]
  };
}
var NEW_TOOLS = [
  {
    name: "send_email",
    description: "Send a short plain-text follow-up email to a customer from the owner connected mailbox. Use ONLY when the customer asks for information by email or agrees to receive one. Never invent recipients.",
    isWebhook: true,
    parameters: {
      type: "object",
      properties: {
        toEmail: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Short subject line, at most 150 characters." },
        bodyText: { type: "string", description: "Plain-text body, 1-3 short paragraphs, at most 4000 characters." }
      },
      required: ["toEmail", "subject", "bodyText"]
    }
  },
  {
    name: "business_knowledge_lookup",
    description: "Answer a business-specific question (hours, services, pricing, policies) from the business knowledge base and website summary. Use when the answer is not already in your instructions.",
    isWebhook: true,
    parameters: KNOWLEDGE_PARAMS
  },
  {
    name: "calendar_find_slots",
    description: "Find up to 3 free time ranges on the owner connected calendar. Use before proposing appointment times.",
    isWebhook: true,
    parameters: FIND_SLOTS_PARAMS
  },
  {
    name: "calendar_book_appointment",
    description: "Book an appointment on the owner connected calendar. Confirm the time with the customer before booking. Times must be ISO 8601 with timezone offset.",
    isWebhook: true,
    parameters: bookParams("Customer")
  },
  {
    name: "dashboard_business_knowledge_lookup",
    description: "Answer an owner question from the business knowledge base and website summary when the answer is not already in your instructions.",
    isWebhook: true,
    parameters: KNOWLEDGE_PARAMS
  },
  {
    name: "dashboard_calendar_find_slots",
    description: "Find up to 3 free time ranges on the owner connected calendar when the owner asks about availability.",
    isWebhook: true,
    parameters: FIND_SLOTS_PARAMS
  },
  {
    name: "dashboard_calendar_book_appointment",
    description: "Book an appointment on the owner connected calendar when the owner asks for it in dashboard chat. Times must be ISO 8601 with timezone offset.",
    isWebhook: true,
    parameters: bookParams("Attendee")
  }
];
var AGENT_TOOLS = {
  Coworker: ["business_knowledge_lookup", "calendar_find_slots", "calendar_book_appointment", "send_email"],
  CoworkerLocal: ["business_knowledge_lookup", "calendar_find_slots", "calendar_book_appointment", "send_email"],
  OwnerCoworker: ["dashboard_business_knowledge_lookup", "dashboard_calendar_find_slots", "dashboard_calendar_book_appointment"],
  OwnerCoworkerLocal: ["dashboard_business_knowledge_lookup", "dashboard_calendar_find_slots", "dashboard_calendar_book_appointment"]
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
\$DC cp /tmp/reseed-marketplace.js mongo:/tmp/reseed-marketplace.js >/dev/null
\$DC exec -T mongo mongosh --quiet rowboat /tmp/reseed-marketplace.js 2>/dev/null || { echo "ERR applying"; exit 1; }

echo "===VERIFY==="
\$DC exec -T mongo mongosh --quiet rowboat --eval '
db.projects.find({}).forEach(function(p){
  var wf = p.liveWorkflow || {};
  print(p._id + "  declaredTools=" + (wf.tools || []).length);
  (wf.agents || []).forEach(function(a){
    print("  " + a.name + ": " + (a.tools || []).join(", "));
  });
});' 2>/dev/null || echo "ERR verify"
echo "===DONE==="
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

console.log(`== Rowboat marketplace-tools reseed ==`);
console.log(`vps=${ip} business=${BUSINESS_ID}`);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 5 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[reseed] exit ${res.exitCode}`);
process.exit(res.exitCode === 0 ? 0 : 1);
