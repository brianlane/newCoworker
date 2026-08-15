/**
 * audit-call-integrity.ts: find calls where the AI voiced both sides, or held
 * a conversation with a recording.
 *
 * WHY A DETECTOR AND NOT A TEST. The Aug 14 2026 fix for this (PR #1377) is a
 * prompt change, and a prompt change cannot be proven the way code can. The
 * unit tests assert the rules are PRESENT in the composed instruction, which
 * is installation, not obedience. A live-model replay was tried and thrown
 * away: the failure happened on Gemini Live's AUDIO channel, where the model
 * streams continuous speech, and a text-mode stand-in cannot reproduce it
 * because the API enforces turn boundaries structurally. That replay passed
 * identically with and without the fix, 0/5 both ways, which makes it a green
 * light that means nothing.
 *
 * So the guard is here instead, on what actually shipped: real transcripts of
 * real calls. It cannot prevent a recurrence, but it will name one within a
 * day instead of us learning it from a customer months later.
 *
 * TWO SIGNATURES, both taken from the incident (call 28f9c228).
 *
 * 1. ROLE LEAK. One assistant turn, transcribed from the audio it actually
 *    played down the line, read: "...that's 975 568. Is that correct?user /
 *    Correct. I want to sell my house ASAP.Got it, ASAP. And what's the
 *    property address...". The literal token "user" inside its own speech is
 *    the tell, and it is a shape no legitimate reply produces.
 *
 * 2. TALKING TO A RECORDING. The caller side of that call was a keypad menu
 *    and then a voicemail system ("Replay your message. Press one."). The AI
 *    ran its full intake script at it. Flagged when the caller turns look
 *    machine-generated and the assistant still took several turns.
 *
 *   tsx debug/audit-call-integrity.ts                      # last 14 days, fleet
 *   tsx debug/audit-call-integrity.ts --days 90
 *   tsx debug/audit-call-integrity.ts --business <uuid>
 *   tsx debug/audit-call-integrity.ts --json
 *
 * Exits non-zero when it finds anything. Read-only. Requires SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import { fetchAllPaged } from "../src/lib/supabase/paging.ts";

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env)");
  process.exit(1);
}

const asJson = process.argv.includes("--json");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}

const days = Number.parseInt(arg("days") ?? "14", 10) || 14;
const businessFilter = arg("business");

/**
 * A role label the model wrote INSIDE its own speech. Anchored to a boundary
 * plus a colon or newline so the ordinary word ("the user manual") does not
 * match; the incident's shape was "Is that correct?user\nCorrect. I want...".
 */
const ROLE_TOKEN_LEAK = /(^|[\s.!?"])(user|assistant|model)\s*[:\n]/i;

/** Phrases only a recording says. Matched against the CALLER side. */
const MACHINE_PHRASES = [
  "press one",
  "press 1",
  "press two",
  "press pound",
  "press star",
  "leave a message",
  "at the beep",
  "after the tone",
  "record your message",
  "re-record",
  "voicemail",
  "is not available",
  "please hold",
  "your call is important"
];

/** Assistant turns before "it held a conversation with the machine". */
const CONVERSATION_TURNS = 3;

type Turn = { role: string | null; content: string | null; turn_index: number | null };
type CallRow = {
  id: string;
  business_id: string;
  caller_e164: string | null;
  started_at: string | null;
};
type Finding = {
  transcriptId: string;
  businessId: string;
  business: string;
  caller: string | null;
  startedAt: string | null;
  kind: "role_leak" | "talked_to_recording";
  detail: string;
};

async function turnsFor(db: SupabaseClient, transcriptId: string): Promise<Turn[]> {
  const { rows } = await fetchAllPaged<Turn>(
    (from, to) =>
      db
        .from("voice_call_transcript_turns")
        .select("role, content, turn_index")
        .eq("transcript_id", transcriptId)
        .order("turn_index", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    { label: `turns for ${transcriptId}` }
  );
  return rows;
}

function looksMachine(text: string): boolean {
  const t = text.toLowerCase();
  return MACHINE_PHRASES.some((p) => t.includes(p));
}

async function main(): Promise<void> {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const { data: bizRows, error: bizErr } = await db.from("businesses").select("id, name");
  if (bizErr) throw new Error(`businesses: ${bizErr.message}`);
  const bizName = new Map((bizRows ?? []).map((b) => [b.id as string, (b.name as string) ?? ""]));

  // Paged, not `.limit(N)`. PostgREST caps a response at 1000 rows and says
  // nothing about it, so a bare limit on an ascending window would drop the
  // NEWEST calls first and still exit clean: this detector would go quiet
  // exactly when there is most to find (Bugbot, PR #1388).
  const { rows: calls, truncated } = await fetchAllPaged<CallRow>(
    (from, to) => {
      let q = db
        .from("voice_call_transcripts")
        .select("id, business_id, caller_e164, started_at")
        .gte("started_at", since)
        // `id` is the tiebreaker, and it is required, not tidiness. Range
        // paging re-runs the query per page and Postgres does not guarantee
        // an order among rows sharing a timestamp, so ordering on
        // `started_at` alone lets a page boundary skip or duplicate a call.
        // A skipped one is a silent miss, which is this detector's worst
        // failure. Partner referrals really do land in the same second.
        .order("started_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      if (businessFilter) q = q.eq("business_id", businessFilter);
      return q;
    },
    { label: "voice_call_transcripts" }
  );
  if (truncated) {
    console.error(
      `WARNING: more than the paging ceiling of calls matched. This result is PARTIAL; ` +
        `narrow it with --days or --business.`
    );
    process.exitCode = 1;
  }

  const findings: Finding[] = [];
  for (const call of calls) {
    const turns = await turnsFor(db, call.id);
    if (turns.length === 0) continue;
    const base = {
      transcriptId: call.id,
      businessId: call.business_id,
      business: bizName.get(call.business_id) ?? "",
      caller: call.caller_e164,
      startedAt: call.started_at
    };

    for (const t of turns) {
      if (t.role !== "assistant" || !t.content) continue;
      if (ROLE_TOKEN_LEAK.test(t.content)) {
        findings.push({
          ...base,
          kind: "role_leak",
          detail: t.content.replace(/\s+/g, " ").slice(0, 240)
        });
        break;
      }
    }

    const callerTurns = turns.filter((t) => t.role !== "assistant" && t.content);
    const assistantTurns = turns.filter((t) => t.role === "assistant" && t.content);
    const machineTurns = callerTurns.filter((t) => looksMachine(t.content!));
    // Every caller turn reads as a recording AND the AI kept going anyway.
    if (
      callerTurns.length > 0 &&
      machineTurns.length === callerTurns.length &&
      assistantTurns.length >= CONVERSATION_TURNS
    ) {
      findings.push({
        ...base,
        kind: "talked_to_recording",
        detail:
          `${assistantTurns.length} assistant turns against ${callerTurns.length} ` +
          `machine-sounding caller turns, e.g. "${machineTurns[0]!.content!.replace(/\s+/g, " ").slice(0, 120)}"`
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ sinceDays: days, found: findings.length, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`No call-integrity failures in the last ${days} days.`);
  } else {
    for (const f of findings) {
      console.log(
        `[${f.kind}] ${f.business} :: ${f.startedAt?.slice(0, 16)} from ${f.caller ?? "?"} ` +
          `(${f.transcriptId})\n    ${f.detail}`
      );
    }
    console.log(
      `\n${findings.length} finding(s). A role_leak means the AI spoke the caller's side; ` +
        `talked_to_recording means it ran its script at a machine. Read the full transcript ` +
        `before acting: these are prompt-adherence failures, not code failures.`
    );
  }
  if (findings.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
