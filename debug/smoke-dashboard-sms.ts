/**
 * End-to-end smoke test of the dashboard chat send_sms tool path.
 *
 * Enqueues a REAL dashboard_chat_jobs row asking the owner coworker to text a
 * number, then polls until the VPS chat-worker → Rowboat (→ Gemini) turn
 * completes and prints the assistant reply. Exercises the full production
 * pipeline: thread/message persistence, job claim, tool-call webhook, Telnyx
 * send, and the reply write-back.
 *
 * Usage:
 *   tsx debug/smoke-dashboard-sms.ts [businessId] [phone] ["message"]
 *
 * ⚠️ Sends a REAL text (gated by the tenant's SMS spend cap) — default target
 * is the operator's own number, not a customer's.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

// Default: New Coworker (HQ, internal) — the real SMS this sends meters
// against our own tenant's cap, never a customer's.
const BUSINESS_ID = process.argv[2] ?? "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const PHONE = process.argv[3] ?? "+16026866672";
const MESSAGE = process.argv[4] ?? "NewCoworker smoke test - dashboard SMS tool is live.";
const ASK = `Text ${PHONE} with this message: ${MESSAGE}`;
const SYSTEM_PREAMBLE =
  "You are the business owner's AI coworker on the dashboard. Answer the owner " +
  "directly and concisely. When the owner asks you to send a text, use the send_sms tool.";

async function main(): Promise<void> {
  const { getOrCreateActiveThread, appendMessage, listMessages } = await import("../src/lib/db/dashboard-chat.ts");
  const { insertChatJob, getChatJobById } = await import("../src/lib/db/dashboard-chat-jobs.ts");
  const thread = await getOrCreateActiveThread(BUSINESS_ID, "smoke sms", undefined);
  const userMsg = await appendMessage(thread.id, "user", `[Dashboard] ${ASK}`, undefined);
  const job = await insertChatJob({
    businessId: BUSINESS_ID,
    threadId: thread.id,
    userMessageId: userMsg.id,
    inputMessages: [
      { role: "system", content: SYSTEM_PREAMBLE },
      { role: "user", content: `[Dashboard] ${ASK}` }
    ],
    statelessInputMessages: null,
    rowboatConversationId: null,
    rowboatState: null
  });
  console.log(`job=${job.id}`);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 300000) { console.log("TIMEOUT"); process.exit(1); }
    await new Promise((r) => setTimeout(r, 2000));
    const row = await getChatJobById(job.id);
    if (!row) continue;
    if (row.status === "done" || row.status === "error") {
      console.log(`status=${row.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (row.status === "error") { console.log(row.error_code, row.error_detail); process.exit(1); }
      const msgs = await listMessages(thread.id);
      const reply = msgs.filter((m) => m.role === "assistant").at(-1);
      console.log(`REPLY:\n${reply?.content}`);
      return;
    }
  }
}
main().catch((e) => { console.error("smoke failed:", e?.message ?? e); process.exit(1); });
