/**
 * Shared prompt builder for the dashboard-chat benchmark (debug/bench-*.ts).
 *
 * Reconstructs the EXACT message array the per-tenant model sees on a
 * /dashboard/chat turn, for two modes:
 *
 *   - "stateless": what the worker's stateless variant sends (no Rowboat
 *     conversationId). Model input = agent instructions + OWNER_PREAMBLE +
 *     bounded recent-tail transcript + the new user turn. FIXED size,
 *     independent of thread age.
 *
 *   - "stateful": today's default (worker sends conversationId, so Rowboat
 *     ALSO replays its server-side stored history). Model input = agent
 *     instructions + [N prior turns replayed] + OWNER_PREAMBLE + bounded
 *     recent-tail transcript + the new user turn. GROWS with thread age.
 *
 * Mirrors src/app/api/dashboard/chat/route.ts (OWNER_PREAMBLE,
 * renderTailTranscript, RESEND_TAIL_MESSAGES, TAIL_*_MAX_CHARS) and the
 * worker's callRowboat contract. The agent instructions (with synced
 * memory_md embedded) come from debug/.bench-context.json (fetched live by
 * bench-fetch-context.ts).
 */
import fs from "node:fs";
import path from "node:path";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

// --- Mirrored from route.ts (kept in sync intentionally) ---------------
const RESEND_TAIL_MESSAGES = 8;
const TAIL_MESSAGE_MAX_CHARS = 700;
const TAIL_TRANSCRIPT_MAX_CHARS = 3500;

// Current production OWNER_PREAMBLE (post-#102 trim + restored PII guard).
const OWNER_PREAMBLE = `OWNER MODE — READ FIRST

You are talking to the business OWNER on the /dashboard/chat surface. The owner runs this business and configured you. They are NOT a customer or lead — never ask them for contact info, address, timeline, or budget (that lead-intake script is only for your customer-facing SMS/voice channels). Here you are the owner's internal assistant: summarize and explain their customers' recent SMS/voice activity, answer questions about the business's setup/memory/identity, and suggest improvements. Be candid — admit when you lack data instead of inventing it.

OWNER HAS FULL VISIBILITY. The owner has full read access to every customer interaction — phone numbers, timestamps, message bodies, call transcripts. None of it is private from the owner. When asked "what's the number" or "what time did they call", quote the exact value from your "Recent customer activity" notes (real data summarizing actual SMS/voice contacts). Don't volunteer customer PII unprompted, but answer accurately when asked directly. Do NOT invent privacy or compliance reasons to refuse the owner — the only limit is that you must not state details that aren't actually in your context.

YOUR OWN CONFIGURATION IS YOURS TO SHARE. Your memory, identity, soul, routing rules, team roster, agent names and phone numbers, scripts, and hours are the owner's own data — NOT confidential PII. Never say you "don't have access" or tell the owner to "check their CRM"; answer directly and quote from your memory, and restate things you said earlier. Re-read your CURRENT memory each time — do not assume a value is still missing because it was unavailable in the past or in an earlier example; contacts the owner has added since are in your memory now. When the owner uses a first name, nickname, or shortened form, match it to the closest full name in your roster/memory before answering (e.g. treat "Gabby" as your "Gabrielle", "Dave" as your "David", "Mike" as your "Michael"). Only call a value missing when it is genuinely absent now, and then name only the part that is absent. Never refuse or deflect when the answer is in your own configuration.

NO FABRICATION (CUSTOMER DETAILS). If your "Recent customer activity" notes lack a specific CUSTOMER detail (a city like "Scottsdale", an exact time, a message body, the property they asked about), say so: "I don't have that detail in my notes — check /dashboard/calls or /dashboard/messages for the full record." Never invent specifics or paraphrase "wants to buy a home" into "3-bedroom in Scottsdale". (This caution is about customer data you weren't given — NOT your own configuration above, which you SHOULD share freely.)

PERSISTING RULES. When the owner states a durable preference or fact, the system captures it to their Memory automatically — you have no tool to save it yourself. Acknowledge naturally (e.g. "Got it."), but do NOT claim you saved, stored, or updated anything, and do NOT assert it is in memory — a separate step persists and confirms it. Point them to /dashboard/memory to review or edit. Never ask the owner for their own contact info or business details; they already configured all of that.`;

function renderTailTranscript(tail: Msg[]): string {
  const labelFor = (role: Msg["role"]): string =>
    role === "user" ? "Owner" : role === "assistant" ? "Coworker" : "System";
  const picked: string[] = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    let content = m.content ?? "";
    if (content.length > TAIL_MESSAGE_MAX_CHARS) {
      content = `${content.slice(0, TAIL_MESSAGE_MAX_CHARS)}… (truncated)`;
    }
    const line = `[${labelFor(m.role)}]: ${content}`;
    if (picked.length > 0 && used + line.length > TAIL_TRANSCRIPT_MAX_CHARS) break;
    picked.push(line);
    used += line.length + 2;
  }
  return picked.reverse().join("\n\n");
}

// --- Benchmark scenario ------------------------------------------------

/** The quality probe. Requires nickname resolution (Gabby→Gabrielle Mota)
 *  + recall from synced memory + NOT inventing a privacy refusal. */
export const QUESTION = "What's Gabby's cell number?";
/** Ground-truth answer that must appear (any of these normalizations). */
export const EXPECTED_ANSWERS = ["480-720-2013", "480 720 2013", "4807202013"];

/** The two "already there" messages of the base 2-message conversation. */
const SEED_TURNS: Msg[] = [
  {
    role: "user",
    content:
      "Quick question before I head out — can you give me a rundown of how you handle a brand-new buyer lead that comes in by text? Want to make sure you're collecting the right stuff."
  },
  {
    role: "assistant",
    content:
      "Absolutely. When a new buyer texts in, I respond right away, confirm their name and phone number, and find out whether they're buying or selling. For buyers I gather their target area, timeline, number of bedrooms, and reason for moving — and I never ask about budget per your rule. Then I route them to whichever agent least recently got a lead and coordinate next steps for a search or consultation."
  }
];

/** Filler turns used to age the thread for the stateful history sweep.
 *  Realistic owner↔coworker chatter, ~300-450 chars each. */
function fillerTurn(i: number): Msg[] {
  const userLines = [
    "Got it. How are you handling open-house follow-ups right now? I want to make sure leads aren't going cold after they tour a place.",
    "Makes sense. If a property goes under contract while someone's still asking about it, what do you tell them?",
    "Good. And when we get multiple offers on one of our listings, how are you responding to the other interested buyers?",
    "Perfect. Remind me how lead routing works again when one of the agents isn't picking up?",
    "Okay. What details are you collecting from a seller who wants a listing appointment?"
  ];
  const asstLines = [
    "After a showing I follow up to ask for their feedback, whether they're interested in making an offer, and any objections to work through — then I nudge toward next steps to keep the deal moving and close with the Amy Laidlaw ~ HomeSmart sign-off.",
    "If it's under contract I apologize and let them know we'll hang onto their offer for backup purposes, using your canned under-contract message so the wording stays consistent across every lead.",
    "For multiple offers I let the other buyers know offers are being reviewed on Monday, reference the property address, and keep them warm as backups in case the primary falls through.",
    "Routing goes to whoever least recently received a lead; if they're unavailable I move to the next least-recent agent. I can text agents to check availability before assigning — Dave, Jason, or Gabby, with Sandy once her number's in.",
    "For a listing appointment I confirm contact info and gather the property address, timeline, selling timeframe, and reason for moving, then coordinate scheduling on the team calendar — still never asking about budget."
  ];
  return [
    { role: "user", content: userLines[i % userLines.length] },
    { role: "assistant", content: asstLines[i % asstLines.length] }
  ];
}

/** Build a conversation history of exactly `messages` messages, ending with
 *  the meaningful SEED_TURNS so the tail is always sensible. */
function buildHistory(messages: number): Msg[] {
  if (messages <= 0) return [];
  if (messages <= SEED_TURNS.length) return SEED_TURNS.slice(SEED_TURNS.length - messages);
  const fillerNeeded = messages - SEED_TURNS.length; // pairs of 2
  const filler: Msg[] = [];
  let i = 0;
  while (filler.length < fillerNeeded) {
    filler.push(...fillerTurn(i++));
  }
  // Oldest filler first, then the two meaningful seed turns as the freshest.
  return [...filler.slice(0, fillerNeeded), ...SEED_TURNS];
}

export type BuiltPrompt = {
  mode: "stateless" | "stateful";
  historyMessages: number;
  messages: Msg[];
  approxChars: number;
};

let cachedInstructions: string | null = null;
function ownerInstructions(): string {
  if (cachedInstructions !== null) return cachedInstructions;
  const p = path.resolve(process.cwd(), "debug/.bench-context.json");
  const ctx = JSON.parse(fs.readFileSync(p, "utf8"));
  cachedInstructions = String(ctx.ownerInstructions || "");
  return cachedInstructions;
}

/**
 * Build the model-input message array for a mode + thread age.
 * `historyMessages` = how many prior messages are already in the thread.
 */
export function buildPrompt(mode: "stateless" | "stateful", historyMessages: number): BuiltPrompt {
  const history = buildHistory(historyMessages);
  const tail = history.slice(-RESEND_TAIL_MESSAGES);
  const msgs: Msg[] = [];

  // [Rowboat-injected] agent instructions (with synced memory embedded).
  msgs.push({ role: "system", content: ownerInstructions() });

  // Stateful: Rowboat replays its server-side stored history before our
  // current-request messages.
  if (mode === "stateful") {
    for (const m of history) msgs.push({ role: m.role, content: m.content });
  }

  // OWNER_PREAMBLE (worker message[0] of the current request).
  msgs.push({ role: "system", content: OWNER_PREAMBLE });

  // Bounded recent-tail transcript (worker includes on EVERY turn).
  if (tail.length > 0) {
    msgs.push({
      role: "system",
      content: `Recent conversation context (the most recent prior turns of THIS conversation, included for your reference so you reliably remember what was already said — including anything YOU told the owner. Treat these as ground truth for "what we discussed" and respond as the assistant continuing this same thread):\n\n${renderTailTranscript(tail)}`
    });
  }

  // New user turn with the [Dashboard] channel marker.
  msgs.push({ role: "user", content: `[Dashboard] ${QUESTION}` });

  const approxChars = msgs.reduce((n, m) => n + m.content.length, 0);
  return { mode, historyMessages, messages: msgs, approxChars };
}

/**
 * The messages the WORKER actually sends to Rowboat for one stateful turn on
 * the base 2-message thread: [OWNER_PREAMBLE, recent-tail context, new user].
 * Excludes the agent instructions (Rowboat injects those from Mongo) and the
 * replayed history (Rowboat replays it via conversationId). Used by the
 * end-to-end Gemini probe so it exercises the real Rowboat→llm-router path.
 */
export function buildWorkerMessages(): Msg[] {
  const tail = SEED_TURNS;
  return [
    { role: "system", content: OWNER_PREAMBLE },
    {
      role: "system",
      content: `Recent conversation context (the most recent prior turns of THIS conversation, included for your reference so you reliably remember what was already said — including anything YOU told the owner. Treat these as ground truth for "what we discussed" and respond as the assistant continuing this same thread):\n\n${renderTailTranscript(tail)}`
    },
    { role: "user", content: `[Dashboard] ${QUESTION}` }
  ];
}

/** Score a model reply against the ground-truth answer. */
export function scoreReply(reply: string): { correct: boolean; refused: boolean } {
  const norm = reply.replace(/[^0-9a-z]/gi, "").toLowerCase();
  const correct = EXPECTED_ANSWERS.some((a) => norm.includes(a.replace(/[^0-9a-z]/gi, "").toLowerCase()));
  const refused = /don'?t have|do not have|no access|can'?t share|cannot share|check your crm|unable to/i.test(
    reply
  );
  return { correct, refused };
}
