/**
 * Live verification harness for the bad-phone-report AiFlow path
 * (route_to_team claim → wait_for_reply → classify → owner/lead emails).
 * Mirrors of the telnyx-sms-inbound claim/wait-resume/unclaim writes are used
 * where the real webhook can't be invoked (Ed25519-signed); the worker,
 * extraction, classify (real Gemini), and Resend emails are the REAL
 * production stack.
 *
 * Defaults to the New Coworker (HQ, internal) tenant so all test traffic
 * burns our own budget. `teardown` only disables the test flow (HQ is
 * long-lived — nothing is deleted).
 *
 * ⚠️ `kickoff` runs a real flow (route_to_team SMS to the tester's phone,
 * real Gemini classify, real emails to the owner address).
 *
 * Usage: tsx debug/bad-phone-verify.ts <setup|kickoff|claim [tf]|report <text>|unclaim|status|teardown>
 *          [--business <uuid>] [--tester +1XXXXXXXXXX] [--owner-email a@b.c] [--run <uuid>]
 *
 * kickoff prints the run id; pass it back as --run on claim/report/unclaim/
 * status so a second kickoff or a stale run can never receive the mutation
 * (without --run those commands target the flow's newest run).
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : fallback;
}

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const BIZ = argValue("--business", HQ_BUSINESS_ID);
const TESTER = argValue("--tester", "+16026866672");
const OWNER_EMAIL = argValue("--owner-email", "brianlane2@gmail.com");
const RUN_ID = argValue("--run", "");
const FLOW_NAME = "Bad Phone Report (TEST)";
const LEAD_PHONE = "+16025559999";

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition } = await import("../src/lib/ai-flows/schema.ts");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const cmd = process.argv[2] ?? "status";

function testDefinition(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "manual" as const },
    options: { suppressDefaultReply: true },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "The lead's full name" },
          { name: "lead_phone", description: "The lead's phone number in E.164" },
          { name: "lead_email", description: "The lead's email address" },
          { name: "lead_address", description: "The lead's street address" }
        ]
      },
      {
        id: "route",
        type: "route_to_team",
        offerTemplate:
          "TEST (bad-phone verify): lead {{vars.lead_name}} {{vars.lead_phone}}. " +
          "Reply 1 to claim or 2 to pass by {{offer.deadline}}. (No action needed — automated test.)",
        ownerFallbackTemplate: "TEST: nobody claimed {{vars.lead_name}} — back to you.",
        responseMinutes: 60
      },
      {
        id: "bp_wait_minutes",
        type: "math",
        operation: "add",
        left: "{{vars.claimed_agent_eta_minutes}}",
        right: "60",
        saveAs: "report_wait_minutes"
      },
      {
        id: "bp_wait",
        type: "wait_for_reply",
        phoneVar: "claimed_agent_phone",
        saveAs: "agent_report",
        timeoutMinutes: 60,
        timeoutMinutesTemplate: "{{vars.report_wait_minutes}}"
      },
      {
        id: "bp_classify",
        type: "classify",
        textVar: "agent_report",
        when: { var: "agent_report", notEquals: "no_reply" },
        question:
          "A team member claimed this lead and tried to call them. This is the " +
          "team member's follow-up text message about that lead.",
        categories: [
          {
            value: "bad_phone_number",
            description:
              "says the lead's phone number is bad - wrong number, disconnected, out of " +
              "service, fake, dead line, no longer in service, or otherwise describes the " +
              "lead's phone negatively"
          },
          {
            value: "other_update",
            description:
              "any other update about the lead - left a voicemail, no answer, will try " +
              "again later, spoke with them, or anything not about a bad phone number"
          }
        ],
        saveAs: "agent_report_class"
      },
      {
        id: "bp_branch",
        type: "branch",
        question: "Did the team member report a bad or invalid phone number for this lead?",
        branches: [
          {
            id: "bp_bad_phone",
            label: "Bad phone number reported",
            condition: { var: "agent_report_class", equals: "bad_phone_number" },
            steps: [
              {
                id: "bp_email_amy",
                type: "send_email",
                to: OWNER_EMAIL,
                subject: "TEST BAD PHONE NUMBER — {{vars.lead_name}} (owner notification)",
                body:
                  "{{vars.claimed_agent}} tried calling the test lead and reported the phone " +
                  'number is bad.\nTheir exact words: "{{vars.agent_report}}"\n\n' +
                  "Lead info:\nName: {{vars.lead_name}}\nPhone on file (bad): {{vars.lead_phone}}\n" +
                  "Email: {{vars.lead_email}}\nAddress: {{vars.lead_address}}\n\n" +
                  "(Verification of the bad-phone-report path — owner-notification analog.)"
              },
              {
                id: "bp_email_lead",
                type: "send_email",
                to: "{{vars.lead_email}}",
                subject: "TEST — Re: your recent inquiry (lead email analog)",
                body:
                  "Hi {{vars.lead_name}},\n\nWe tried to give you a call, but the phone number " +
                  "we have on file doesn't seem to be working. Could you reply with your best " +
                  "phone number so we can connect?\n\n(Verification of the bad-phone-report " +
                  "path — lead-email analog.)"
              }
            ]
          }
        ],
        else: [
          {
            id: "bp_forward",
            type: "notify_owner",
            when: { var: "agent_report", notEquals: "no_reply" },
            message:
              "TEST update from {{vars.claimed_agent}} about {{vars.lead_name}} " +
              "({{vars.lead_phone}}): {{vars.agent_report}}"
          }
        ]
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

/**
 * The run a mutating command targets: the exact --run id when given (still
 * scoped to this business + test flow, so a typo can't hit another flow),
 * else the flow's newest run.
 */
async function latestRun(): Promise<Record<string, any> | null> {
  const { data: flow } = await db
    .from("ai_flows")
    .select("id")
    .eq("business_id", BIZ)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (!flow) return null;
  let query = db
    .from("ai_flow_runs")
    .select("id,status,current_step,context,revision,respond_by_at,updated_at,last_error")
    .eq("business_id", BIZ)
    .eq("flow_id", (flow as { id: string }).id);
  if (RUN_ID) query = query.eq("id", RUN_ID);
  const { data } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data as Record<string, any>) ?? null;
}

if (cmd === "setup") {
  const def = testDefinition();
  const { data: existing } = await db
    .from("ai_flows")
    .select("id")
    .eq("business_id", BIZ)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (existing) {
    const { error } = await db
      .from("ai_flows")
      .update({ definition: def, enabled: true })
      .eq("id", (existing as { id: string }).id);
    if (error) throw new Error(error.message);
    console.log(`updated flow ${(existing as { id: string }).id}`);
  } else {
    const { data, error } = await db
      .from("ai_flows")
      .insert({ business_id: BIZ, name: FLOW_NAME, enabled: true, definition: def })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    console.log(`created flow ${(data as { id: string }).id}`);
  }
} else if (cmd === "kickoff") {
  const { data: flow } = await db
    .from("ai_flows")
    .select("id")
    .eq("business_id", BIZ)
    .eq("name", FLOW_NAME)
    .single();
  const stamp = Date.now();
  const { data, error } = await db
    .from("ai_flow_runs")
    .insert({
      business_id: BIZ,
      flow_id: (flow as { id: string }).id,
      status: "queued",
      context: {
        trigger: {
          channel: "manual",
          from: "",
          windowText:
            `New test lead: Test Lead. Phone: ${LEAD_PHONE}. Email: ${OWNER_EMAIL}. ` +
            "Address: 123 Test St, Phoenix, AZ 85001.",
          test_stamp: stamp
        },
        vars: {}
      }
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  console.log(`enqueued run ${(data as { id: string }).id}`);
  console.log(`target it explicitly on later commands: --run ${(data as { id: string }).id}`);
} else if (cmd === "claim") {
  // MIRROR of telnyx-sms-inbound's live-claim resume (webhook is signature-gated).
  const timeframe = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "";
  const run = await latestRun();
  if (!run || !["awaiting_agent", "queued"].includes(run.status)) {
    throw new Error(`no claimable run (status: ${run?.status ?? "none"})`);
  }
  const routing = (run.context?.routing ?? {}) as Record<string, unknown>;
  // Mirror the webhook's offer guard (it resolves the run via
  // context->routing->>offered = from): only a run actually offered to the
  // tester is claimable — never a queued run whose offer isn't live yet.
  if (routing.offered !== TESTER) {
    throw new Error(
      `run isn't offered to the tester yet (offered: ${JSON.stringify(routing.offered ?? null)}) — ` +
        "wait for the route_to_team offer SMS before claiming"
    );
  }
  routing.last_event = "claim";
  routing.reply_from = TESTER;
  if (timeframe) routing.claim_timeframe = timeframe;
  else delete routing.claim_timeframe;
  delete routing.pass_reason;
  const { data, error } = await db
    .from("ai_flow_runs")
    .update({
      status: "queued",
      awaiting_agent_e164: null,
      respond_by_at: null,
      context: { ...run.context, routing },
      updated_at: new Date().toISOString()
    })
    .eq("id", run.id)
    .eq("revision", run.revision)
    .in("status", ["awaiting_agent", "queued"])
    .select("id");
  if (error || (data ?? []).length === 0) throw new Error(error?.message ?? "claim raced");
  console.log(`claimed run ${run.id}${timeframe ? ` (ETA ${timeframe})` : ""}`);
} else if (cmd === "report") {
  // MIRROR of resumeAwaitingReplyRun (the staff wait-resume exception).
  const text = process.argv.slice(3).filter((a) => !a.startsWith("--")).join(" ");
  if (!text) throw new Error("usage: report <text>");
  const run = await latestRun();
  if (!run || run.status !== "awaiting_reply") {
    throw new Error(`no parked run (status: ${run?.status ?? "none"})`);
  }
  const waiting = (run.context?.waiting_reply ?? {}) as Record<string, unknown>;
  if (waiting.from !== TESTER) throw new Error(`wait watches ${waiting.from}, not the tester`);
  const saveAs = typeof waiting.save_as === "string" && waiting.save_as ? waiting.save_as : "reply_text";
  const marker = typeof waiting.marker === "string" && waiting.marker ? { [waiting.marker]: "1" } : {};
  const { data, error } = await db
    .from("ai_flow_runs")
    .update({
      status: "queued",
      respond_by_at: null,
      claimed_at: null,
      context: {
        ...run.context,
        vars: { ...(run.context?.vars ?? {}), [saveAs]: text, ...marker },
        waiting_reply: { ...waiting, result: "reply" }
      },
      updated_at: new Date().toISOString()
    })
    .eq("id", run.id)
    .eq("revision", run.revision)
    .eq("status", "awaiting_reply")
    .select("id");
  if (error || (data ?? []).length === 0) throw new Error(error?.message ?? "resume raced");
  console.log(`reported on run ${run.id}: "${text}"`);
} else if (cmd === "unclaim") {
  // MIRROR of tryUnclaim (incl. the new awaiting_reply status).
  const run = await latestRun();
  const statuses = ["done", "awaiting_agent", "queued", "awaiting_approval", "awaiting_reply"];
  if (!run || !statuses.includes(run.status)) {
    throw new Error(`no run to unclaim (status: ${run?.status ?? "none"})`);
  }
  const routing = (run.context?.routing ?? {}) as Record<string, unknown>;
  if (routing.claimed_by !== TESTER) throw new Error("tester doesn't hold this lead");
  const idx = typeof routing.route_step_index === "number" ? routing.route_step_index : -1;
  if (idx < 0) throw new Error("no route_step_index rewind target");
  routing.last_event = "unclaim";
  routing.reply_from = TESTER;
  const { data, error } = await db
    .from("ai_flow_runs")
    .update({
      status: "queued",
      current_step: idx,
      awaiting_agent_e164: null,
      respond_by_at: null,
      claimed_at: null,
      earliest_claim_at: null,
      context: { ...run.context, routing },
      updated_at: new Date().toISOString()
    })
    .eq("id", run.id)
    .eq("revision", run.revision)
    .in("status", statuses)
    .select("id");
  if (error || (data ?? []).length === 0) throw new Error(error?.message ?? "unclaim raced");
  console.log(`unclaimed run ${run.id} (status was ${run.status})`);
} else if (cmd === "status") {
  const run = await latestRun();
  if (!run) {
    console.log("no runs");
  } else {
    const vars = (run.context?.vars ?? {}) as Record<string, unknown>;
    console.log(`run ${run.id} status=${run.status} step=${run.current_step} respond_by=${run.respond_by_at ?? "-"} err=${run.last_error ?? "-"}`);
    for (const k of [
      "lead_name", "lead_phone", "lead_email", "claimed_agent", "claimed_agent_phone",
      "claimed_agent_eta_minutes", "report_wait_minutes", "agent_report", "agent_report_class"
    ]) {
      if (vars[k] !== undefined) console.log(`  ${k} = ${JSON.stringify(vars[k])}`);
    }
    console.log(`  waiting_reply = ${JSON.stringify(run.context?.waiting_reply ?? null)}`);
    console.log(`  routing = ${JSON.stringify(run.context?.routing ?? null)}`);
    const { data: steps } = await db
      .from("ai_flow_run_steps")
      .select("step_index,step_type,status,result,error")
      .eq("run_id", run.id)
      .order("step_index");
    for (const s of (steps ?? []) as Array<Record<string, unknown>>) {
      console.log(`  #${s.step_index} ${s.step_type} ${s.status} ${JSON.stringify(s.result ?? null)?.slice(0, 160)} ${s.error ?? ""}`);
    }
    const { data: emails } = await db
      .from("email_log")
      .select("to_email,subject,status,created_at")
      .eq("business_id", BIZ)
      .order("created_at", { ascending: false })
      .limit(4);
    console.log(`  recent emails: ${JSON.stringify(emails)}`);
  }
} else if (cmd === "teardown") {
  const { data: flow } = await db
    .from("ai_flows")
    .select("id")
    .eq("business_id", BIZ)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (flow) {
    const { error } = await db
      .from("ai_flows")
      .update({ enabled: false })
      .eq("id", (flow as { id: string }).id);
    if (error) throw new Error(error.message);
    console.log(`disabled flow ${(flow as { id: string }).id}`);
  } else {
    console.log("no test flow");
  }
} else {
  throw new Error(`unknown command: ${cmd}`);
}
