/**
 * Live end-to-end smoke test for the owner-dashboard chat queue path after
 * routing OwnerCoworker to Gemini (PR #104).
 *
 * Exercises the FULL production path that the probe (probe-gemini-owner.ts)
 * does NOT cover: it enqueues a real `dashboard_chat_jobs` row exactly like the
 * Vercel route does, then waits for the per-tenant VPS chat-worker to claim it,
 * call Rowboat (-> llm-router -> Gemini), persist the assistant reply, and mark
 * the job done. It reports wall-clock latency and prints the reply so an
 * operator can eyeball correctness.
 *
 * Reads the repo `.env` for SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service
 * role; this writes a real thread/message into the tenant). Safe to run against
 * the test tenant; the reply lands in that tenant's active thread.
 *
 * Usage: tsx debug/smoke-owner-chat.ts [businessId] ["question"]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

// Default: New Coworker (HQ, internal) — smoke turns burn the tenant's AI
// budget, so they run against our own tenant unless told otherwise.
const BUSINESS_ID = process.argv[2] ?? "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const QUESTION = process.argv[3] ?? "Quick check: what is Gabby's phone number?";
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;

// Minimal but representative system framing. The tenant's durable memory is
// already synced into the OwnerCoworker agent instructions on the VPS, so a
// bare question is enough to verify the Gemini path answers from memory.
const SYSTEM_PREAMBLE =
  "You are the business owner's AI coworker on the dashboard. Answer the owner " +
  "directly and concisely using the business memory and recent customer " +
  "activity in your instructions. If you genuinely do not have a value, say so.";

async function main(): Promise<void> {
  const { getOrCreateActiveThread, appendMessage, listMessages } = await import(
    "../src/lib/db/dashboard-chat.ts"
  );
  const { insertChatJob, getChatJobById } = await import("../src/lib/db/dashboard-chat-jobs.ts");

  console.log(`business=${BUSINESS_ID}`);
  console.log(`question=${JSON.stringify(QUESTION)}`);

  const thread = await getOrCreateActiveThread(BUSINESS_ID, "smoke test", undefined);
  console.log(`thread=${thread.id}`);

  const userMsg = await appendMessage(thread.id, "user", `[Dashboard] ${QUESTION}`, undefined);
  console.log(`user_message_id=${userMsg.id}`);

  // Fresh, stateless turn: no prior Rowboat conversation/state, so the single
  // attempt's input is already self-contained (no stateless-retry fallback).
  const job = await insertChatJob({
    businessId: BUSINESS_ID,
    threadId: thread.id,
    userMessageId: userMsg.id,
    inputMessages: [
      { role: "system", content: SYSTEM_PREAMBLE },
      { role: "user", content: `[Dashboard] ${QUESTION}` }
    ],
    statelessInputMessages: null,
    rowboatConversationId: null,
    rowboatState: null
  });
  console.log(`job=${job.id} status=${job.status}`);

  const t0 = Date.now();
  let last = job.status;
  for (;;) {
    if (Date.now() - t0 > POLL_TIMEOUT_MS) {
      console.log(`\nTIMEOUT after ${Math.round((Date.now() - t0) / 1000)}s (last status=${last})`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const row = await getChatJobById(job.id);
    if (!row) continue;
    if (row.status !== last) {
      console.log(`  [+${((Date.now() - t0) / 1000).toFixed(1)}s] status -> ${row.status}`);
      last = row.status;
    }
    if (row.status === "done" || row.status === "error") {
      const wall = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n=== ${row.status.toUpperCase()} in ${wall}s ===`);
      if (row.status === "error") {
        console.log(`error_code=${row.error_code}`);
        console.log(`error_detail=${row.error_detail}`);
        process.exit(1);
      }
      const msgs = await listMessages(thread.id);
      const reply = msgs.filter((m) => m.role === "assistant").at(-1);
      console.log(`assistant_message_id=${row.assistant_message_id}`);
      console.log(`\nREPLY:\n${reply?.content ?? "(no assistant message found)"}`);
      return;
    }
  }
}

main().catch((err) => {
  console.error("smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
