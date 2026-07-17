/**
 * Enqueue one run of the New Coworker (HQ, internal) tenant's copy of
 * Truly's Privyr flow, simulating the Privyr "New Lead" alert email for the
 * tester (run flow-test-setup.ts first to lay the harness on the HQ tenant).
 * Each
 * invocation gets a unique dedupe key so scenarios can repeat — but run
 * flow-test-reset.ts first, or the duplicate-lead guard will (correctly)
 * suppress the intro for a lead with a recent finished run.
 *
 * ONE scenario at a time: two parked runs waiting on the same number would
 * BOTH consume the tester's next text (wait-resume matches every parked
 * run for the sender).
 *
 * Usage: tsx debug/flow-test-kickoff.ts [scenarioLabel]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

/** New Coworker (HQ, internal) — the single internal smoke/e2e tenant. */
const TEST_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const FLOW_NAME = "Lead intake & follow-up (Privyr) (TEST COPY of Truly)";
const TESTER_NAME = "Brian";
const TESTER_E164 = "+16026866672";
const LABEL = process.argv[2] ?? "scenario";

const { createClient } = await import("@supabase/supabase-js");
const { enqueueAiFlowRun } = await import("../src/lib/ai-flows/db.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: flow, error } = await db
  .from("ai_flows")
  .select("id")
  .eq("business_id", TEST_BUSINESS_ID)
  .eq("name", FLOW_NAME)
  .single();
if (error || !flow) throw new Error(`flow lookup: ${error?.message ?? "not found"}`);

const stamp = Date.now();
const windowText = [
  `New Lead: ${TESTER_NAME}`,
  `Congrats! You have a new lead from New Coworker HQ: ${TESTER_NAME}. Lead via Privyr ` +
    `Lead Forms - Auto Lead Name: ${TESTER_NAME} Phone: ${TESTER_E164} Email: Comments: ` +
    "Form Name: Auto Lead Lead Form Url: https://www.privyr.com/form/testtest " +
    "Source: Privyr Lead Forms - Auto Lead View this lead in Privyr to easily " +
    "contact, manage, and follow up with them."
].join("\n");

const run = await enqueueAiFlowRun(
  {
    businessId: TEST_BUSINESS_ID,
    flowId: (flow as { id: string }).id,
    trigger: {
      channel: "tenant_email",
      from: "alerts-noreply@privyr.com",
      to: "flowtest@newcoworker.com",
      subject: `New Lead: ${TESTER_NAME}`,
      message_id: `<flow-test-${LABEL}-${stamp}@newcoworker.test>`,
      url: "",
      image: "",
      windowText
    },
    dedupeKey: `flow-test-${LABEL}-${stamp}`
  },
  db as never
);
console.log(run ? `enqueued run ${run.id} (${LABEL})` : "duplicate — not enqueued");
