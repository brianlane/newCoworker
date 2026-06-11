/**
 * Rowboat tool-webhook reseed (Settings → Coworker tools, phase 2).
 *
 * Retrofits an already-provisioned tenant's Rowboat project so its workflow
 * tools execute for REAL through the platform dispatcher
 * (/api/rowboat/tool-call) instead of being LLM-mocked placeholders:
 *
 *   - project.webhookUrl ← APP_BASE_URL/api/rowboat/tool-call
 *   - project.secret     ← ROWBOAT_GATEWAY_TOKEN (JWT signing key the
 *                          dispatcher verifies with)
 *   - customer_* tools   ← isWebhook: true, phone REQUIRED (the webhook
 *                          payload has no caller context)
 *   - send_sms           ← new dashboard-chat tool, declared + added to
 *                          OwnerCoworker / OwnerCoworkerLocal
 *   - dashboard_customer_* twins ← dashboard-surface declarations of the
 *                          customer tools (separate toggle, honest
 *                          "dashboard" interaction channel); Owner agents
 *                          are repointed from customer_* to these
 *
 * Surgical Mongo patch over SSH — no container churn, no .env regeneration
 * (mirrors debug/reseed-sms-workflow.ts). Idempotent: re-running converges
 * to the same state and never duplicates the send_sms tool.
 *
 * deploy-client.sh seeds all of this for NEW tenants; this script exists for
 * boxes provisioned before the dispatcher shipped.
 *
 * Usage: tsx debug/reseed-tool-webhook.ts [businessId]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BUSINESS_ID = args[0] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const remote = `
set -uo pipefail
RB_ENV=/opt/rowboat/.env
APP=\$(grep -m1 '^APP_BASE_URL=' "\$RB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
TOK=\$(grep -m1 '^ROWBOAT_GATEWAY_TOKEN=' "\$RB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
if [ -z "\$APP" ] || [ -z "\$TOK" ]; then
  echo "ERROR: APP_BASE_URL or ROWBOAT_GATEWAY_TOKEN missing in \$RB_ENV — cannot wire webhook"
  exit 1
fi
WEBHOOK="\${APP%/}/api/rowboat/tool-call"
echo "webhook=\$WEBHOOK token=set"

DC="docker compose -f /opt/rowboat/docker-compose.yml"

printf 'const WEBHOOK=%s;\\nconst SECRET=%s;\\n' "\\"\$WEBHOOK\\"" "\\"\$TOK\\"" > /tmp/reseed-webhook.js
cat >> /tmp/reseed-webhook.js <<'JS_EOF'
var NEW_TOOLS = [
  {
    name: "send_sms",
    description: "Send a text message from the business number to any phone number. Use ONLY when the owner explicitly asks in dashboard chat for a text to be sent. Never invent recipients.",
    isWebhook: true,
    parameters: {
      type: "object",
      properties: {
        toE164: { type: "string", description: "Recipient phone in E.164, e.g. +15551234567." },
        body: { type: "string", description: "Plain-text message body, at most 1600 characters." }
      },
      required: ["toE164", "body"]
    }
  },
  {
    name: "dashboard_customer_lookup_by_phone",
    description: "Look up the cross-channel customer profile (display name, rolling summary, last channel/date, total interaction count) for a customer phone number the owner asks about.",
    isWebhook: true,
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string", description: "E.164 phone to look up, e.g. +15551234567." }
      },
      required: ["phone"]
    }
  },
  {
    name: "dashboard_customer_set_display_name",
    description: "Persist a customer name on their profile when the owner states it in dashboard chat. Will not overwrite a name the owner already set from the customers page.",
    isWebhook: true,
    parameters: {
      type: "object",
      properties: {
        displayName: { type: "string", description: "The customer name. Will be normalized server-side." },
        phone: { type: "string", description: "E.164 phone to attribute the name to." }
      },
      required: ["displayName", "phone"]
    }
  },
  {
    name: "dashboard_customer_append_pinned_note",
    description: "Append a permanent fact to a customer pinned notes when the owner states it in dashboard chat. The note survives every future summary. Use sparingly.",
    isWebhook: true,
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "The fact to pin, in the owner words. Keep concise." },
        phone: { type: "string", description: "E.164 phone to attribute the note to." }
      },
      required: ["note", "phone"]
    }
  }
];
var PHONE_REQUIRED = {
  customer_lookup_by_phone: ["phone"],
  customer_set_display_name: ["displayName", "phone"],
  customer_append_pinned_note: ["note", "phone"]
};
// Owner agents are repointed onto the dashboard-surface twins so the
// dispatcher can attribute calls (separate toggle + honest channel).
var OWNER_TOOL_RENAMES = {
  customer_lookup_by_phone: "dashboard_customer_lookup_by_phone",
  customer_set_display_name: "dashboard_customer_set_display_name",
  customer_append_pinned_note: "dashboard_customer_append_pinned_note"
};
function patch(wf) {
  if (!wf) return false;
  var changed = false;
  if (Array.isArray(wf.tools)) {
    wf.tools.forEach(function (t) {
      if (PHONE_REQUIRED[t.name]) {
        if (t.isWebhook !== true) { t.isWebhook = true; changed = true; }
        if (t.parameters) {
          var want = PHONE_REQUIRED[t.name];
          if (JSON.stringify(t.parameters.required || []) !== JSON.stringify(want)) {
            t.parameters.required = want;
            changed = true;
          }
          // Webhook path has no caller context: drop "omit for current
          // caller" phrasing from the phone arg description.
          if (t.parameters.properties && t.parameters.properties.phone) {
            t.parameters.properties.phone.description = "E.164 phone, e.g. +15551234567.";
          }
        }
      }
    });
    NEW_TOOLS.forEach(function (def) {
      if (!wf.tools.some(function (t) { return t.name === def.name; })) {
        wf.tools.push(def);
        changed = true;
      }
    });
  }
  if (Array.isArray(wf.agents)) {
    wf.agents.forEach(function (a) {
      if (a.name === "OwnerCoworker" || a.name === "OwnerCoworkerLocal") {
        a.tools = (a.tools || []).map(function (name) {
          if (OWNER_TOOL_RENAMES[name]) { changed = true; return OWNER_TOOL_RENAMES[name]; }
          return name;
        });
        if (a.tools.indexOf("send_sms") === -1) { a.tools.push("send_sms"); changed = true; }
      }
    });
  }
  return changed;
}
var n = 0, updated = 0;
db.projects.find({}).forEach(function (p) {
  n++;
  var changed = false;
  if (p.webhookUrl !== WEBHOOK) { p.webhookUrl = WEBHOOK; changed = true; }
  if (p.secret !== SECRET) { p.secret = SECRET; changed = true; }
  if (patch(p.liveWorkflow)) changed = true;
  if (patch(p.draftWorkflow)) changed = true;
  if (changed) {
    db.projects.updateOne({ _id: p._id }, { $set: {
      webhookUrl: p.webhookUrl,
      secret: p.secret,
      liveWorkflow: p.liveWorkflow,
      draftWorkflow: p.draftWorkflow
    }});
    updated++;
  }
});
print(JSON.stringify({ projects: n, updated: updated }));
JS_EOF

echo "===APPLY==="
\$DC cp /tmp/reseed-webhook.js mongo:/tmp/reseed-webhook.js >/dev/null
\$DC exec -T mongo mongosh --quiet rowboat /tmp/reseed-webhook.js 2>/dev/null || { echo "ERR applying"; exit 1; }

echo "===VERIFY==="
\$DC exec -T mongo mongosh --quiet rowboat --eval '
db.projects.find({}).forEach(function(p){
  var wf = p.liveWorkflow || {};
  var tools = (wf.tools || []).map(function(t){ return t.name + (t.isWebhook ? "[webhook]" : "[mock]"); });
  var owner = ((wf.agents || []).find(function(a){ return a.name === "OwnerCoworker"; }) || {}).tools || [];
  print(p._id + "  webhookUrl=" + (p.webhookUrl || "NONE") + "  secretLen=" + ((p.secret || "").length));
  print("  tools: " + tools.join(", "));
  print("  OwnerCoworker.tools: " + owner.join(", "));
});' 2>/dev/null || echo "ERR verify"
echo "===DONE==="
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

console.log(`== Rowboat tool-webhook reseed ==`);
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
