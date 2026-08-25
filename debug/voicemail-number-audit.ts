/**
 * Did the AI speak a phone number it was never given?
 *
 * Amy Laidlaw, 2026-08-25: "whose phone number is this?" Her coworker had
 * told a lead to call 480-256-2580, a number belonging to nobody on the
 * account. Over the 45 days before the fix it invented THIRTEEN distinct
 * numbers, one per voicemail. The scripts were always right; the model
 * ad-libbed at the beep before fetching them, and the instruction asked for
 * "how to reach you" without supplying a number. Fixed in PR #1612.
 *
 * The fix is a PROMPT change on a realtime audio model, which no test tier in
 * this repo can drive, so this script is the verification: it reads what the
 * assistant actually said on real calls and lists every contact number that
 * is not one the business owns.
 *
 * Read-only. Usage:
 *   npx tsx debug/voicemail-number-audit.ts --business <uuid> [--since ISO]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const businessId = arg("business");
if (!businessId) {
  console.error("usage: npx tsx debug/voicemail-number-audit.ts --business <uuid> [--since ISO]");
  process.exit(1);
}
const since = arg("since") ?? new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

/** Numbers the business legitimately owns, in spoken 3-3-4 form. */
async function ownNumbers(): Promise<Set<string>> {
  const out = new Set<string>();
  const push = (v: unknown) => {
    const d = String(v ?? "").replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) out.add(`${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`);
    else if (d.length === 10) out.add(`${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`);
  };
  const { data: biz } = await db.from("businesses").select("*").eq("id", businessId).maybeSingle();
  for (const [k, v] of Object.entries((biz ?? {}) as Record<string, unknown>)) {
    if (/phone|e164|did|number/i.test(k)) push(v);
  }
  const { data: prefs } = await db
    .from("notification_preferences")
    .select("phone_number")
    .eq("business_id", businessId)
    .maybeSingle();
  push((prefs as { phone_number?: string } | null)?.phone_number);
  // Anything an authored script is allowed to say.
  const { data: flows } = await db.from("ai_flows").select("definition").eq("business_id", businessId);
  for (const f of flows ?? []) {
    const text = JSON.stringify((f as { definition: unknown }).definition);
    for (const m of text.matchAll(/\b(\d{3})[ .-](\d{3})[ .-](\d{4})\b/g)) {
      out.add(`${m[1]}-${m[2]}-${m[3]}`);
    }
  }
  return out;
}

const own = await ownNumbers();
console.log(`business ${businessId}`);
console.log(`window since ${since}`);
console.log(`numbers this business may legitimately speak: ${[...own].sort().join(", ") || "(none found)"}`);

const { data: trs, error } = await db
  .from("voice_call_transcripts")
  .select("id, created_at, direction, answering_machine_result")
  .eq("business_id", businessId)
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(1000);
if (error) throw error;

let calls = 0;
const bad: Array<{ at: string; n: string; said: string }> = [];
for (const t of trs ?? []) {
  const row = t as { id: string; created_at: string };
  const { data: turns } = await db
    .from("voice_call_transcript_turns")
    .select("content")
    .eq("transcript_id", row.id)
    .eq("role", "assistant");
  if (!turns || turns.length === 0) continue;
  calls += 1;
  for (const x of turns) {
    const said = String((x as { content: string }).content ?? "");
    for (const m of said.matchAll(/\b(?:\+?1[ .\-()]*)?\(?(\d{3})\)?[ .\-]*(\d{3})[ .\-]*(\d{4})\b/g)) {
      const n = `${m[1]}-${m[2]}-${m[3]}`;
      if (!own.has(n)) bad.push({ at: row.created_at, n, said: said.slice(0, 140) });
    }
  }
}

console.log(`\ncalls with assistant speech in window: ${calls}`);
if (bad.length === 0) {
  console.log("NO invented contact numbers spoken. Clean.");
} else {
  console.log(`INVENTED NUMBERS SPOKEN: ${bad.length} (${new Set(bad.map((b) => b.n)).size} distinct)`);
  for (const b of bad) console.log(`  ${b.at}  ${b.n}\n     "${b.said}"`);
}
