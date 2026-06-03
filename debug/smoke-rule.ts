/**
 * End-to-end smoke test for server-side owner-rule memory capture.
 *
 * Enqueues a `dashboard_chat_jobs` row exactly like /api/dashboard/chat does
 * (OWNER_PREAMBLE + a "[Dashboard] <rule>" user turn), waits for the tenant's
 * VPS worker to process it, then verifies: (1) business_configs.memory_md
 * gained the rule, and (2) the assistant message carries the honest
 * "Saved to your business memory" confirmation.
 *
 * Usage:
 *   tsx debug/smoke-rule.ts [businessId]
 *
 * Exit code 0 = PASS (memory grew + rule present + honest confirmation).
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const STAMP = new Date().toISOString().replace(/[^0-9]/g, "").slice(8, 14); // HHMMSS
const RULE = `Never reveal customer wait-time estimates over SMS (smoke ${STAMP}).`;

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { getOrCreateActiveThread, appendMessage, listMessages } = await import(
  "../src/lib/db/dashboard-chat.ts"
);
const { insertChatJob } = await import("../src/lib/db/dashboard-chat-jobs.ts");
const { OWNER_PREAMBLE } = await import("../src/app/api/dashboard/chat/route.ts");

const db = await createSupabaseServiceClient();

async function readMemory(): Promise<string> {
  const { data, error } = await db
    .from("business_configs")
    .select("memory_md")
    .eq("business_id", BUSINESS_ID)
    .maybeSingle();
  if (error) throw new Error(`readMemory: ${error.message}`);
  return (data?.memory_md as string | null) ?? "";
}

const before = await readMemory();
console.log(`[smoke] business=${BUSINESS_ID}`);
console.log(`[smoke] rule="${RULE}"`);
console.log(`[smoke] memory_md before: ${before.length} chars`);

const thread = await getOrCreateActiveThread(BUSINESS_ID, `smoke ${STAMP}`);
const userMsg = await appendMessage(thread.id, "user", RULE);
const inputMessages = [
  { role: "system" as const, content: OWNER_PREAMBLE },
  { role: "user" as const, content: `[Dashboard] ${RULE}` }
];
const job = await insertChatJob({
  businessId: BUSINESS_ID,
  threadId: thread.id,
  userMessageId: userMsg.id,
  inputMessages,
  statelessInputMessages: null,
  rowboatConversationId: null,
  rowboatState: null
});
console.log(`[smoke] enqueued job=${job.id} thread=${thread.id} userMsg=${userMsg.id}`);

type FinalJob = {
  status: string;
  assistant_message_id: number | null;
  error_code: string | null;
  error_detail: string | null;
};

const deadline = Date.now() + 5 * 60 * 1000;
let final: FinalJob | null = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const { data, error } = await db
    .from("dashboard_chat_jobs")
    .select("status, assistant_message_id, error_code, error_detail")
    .eq("id", job.id)
    .single();
  if (error) {
    console.log(`[smoke] poll error: ${error.message}`);
    continue;
  }
  process.stdout.write(`\r[smoke] job status=${data.status}            `);
  if (data.status === "done" || data.status === "error") {
    final = data as FinalJob;
    break;
  }
}
console.log("");

if (!final) {
  console.log("[smoke] TIMEOUT waiting for job to finish");
  process.exit(1);
}
if (final.status === "error") {
  console.log(`[smoke] job ERRORED code=${final.error_code} detail=${final.error_detail}`);
  process.exit(1);
}

const messages = await listMessages(thread.id);
const assistant = messages.find((m) => m.id === final!.assistant_message_id);
const after = await readMemory();

console.log("\n========== ASSISTANT REPLY ==========");
console.log(assistant?.content ?? "(assistant message not found)");
console.log("========== END REPLY ==========\n");

const memGrew = after.length > before.length;
const ruleInMemory =
  after.includes("wait-time") || after.toLowerCase().includes(`smoke ${STAMP}`.toLowerCase());
const confirmed = (assistant?.content ?? "").includes("Saved to your business memory");

console.log(`[smoke] memory_md after: ${after.length} chars (before ${before.length})`);
console.log(`[smoke] memory grew:            ${memGrew}`);
console.log(`[smoke] rule present in memory: ${ruleInMemory}`);
console.log(`[smoke] honest confirmation:    ${confirmed}`);
if (memGrew) {
  console.log("\n--- memory_md tail (last 600 chars) ---");
  console.log(after.slice(-600));
}

const pass = memGrew && ruleInMemory && confirmed;
console.log(`\n[smoke] RESULT: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
