import { loadEnv } from "./_shared.ts";
loadEnv();
const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const ASK = process.argv[2] ?? "Do I have any calendar openings tomorrow afternoon?";
const SYSTEM_PREAMBLE =
  "You are the business owner's AI coworker on the dashboard. Answer the owner " +
  "directly and concisely, using your tools when they apply.";
async function main(): Promise<void> {
  const { getOrCreateActiveThread, appendMessage, listMessages } = await import("../src/lib/db/dashboard-chat.ts");
  const { insertChatJob, getChatJobById } = await import("../src/lib/db/dashboard-chat-jobs.ts");
  const thread = await getOrCreateActiveThread(BUSINESS_ID, "smoke tools", undefined);
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
