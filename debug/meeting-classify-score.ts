#!/usr/bin/env tsx
/**
 * Score the meeting-minutes classifier against meetings whose real outcome
 * is known.
 *
 * The classifier decides what a recorded call WAS, and `signed` moves the
 * contact's card to Won, so a prompt change here is a change to what the
 * CRM writes. Arguing about prompt wording is cheap and unreliable; this
 * runs the real prompt against real imported documents, several times each,
 * and prints hits against the label you supply.
 *
 * It was written to settle exactly one such argument (PR "meeting classify:
 * labelled sections"): the shipped prompt scored 3/9 on three graded
 * meetings and returned a different answer run to run on one of them, and
 * two plausible-sounding fixes each made it worse before the shape below
 * reached 9/9. Reuse it before touching `MEETING_CLASSIFY_GUARD`,
 * `MEETING_OUTCOME_CATEGORIES`, or `buildMeetingClassifyInput`.
 *
 * The graded meetings are NOT checked in: they are customer call
 * transcripts. Pass document ids from the tenant you are testing against.
 * Find them with:
 *
 *   select d.id, d.title, i.outcome
 *     from zoom_transcript_imports i
 *     join business_documents d on d.id = i.document_id
 *    order by i.created_at desc;
 *
 * ⚠️ Small real Gemini spend (one flash-lite call per document per run),
 * billed to nobody: this calls the model directly rather than through the
 * metered path, so it does not touch a tenant's AI budget. No writes.
 *
 * Usage:
 *   npx tsx debug/meeting-classify-score.ts <docId>=signed <docId>=follow_up
 *   npx tsx debug/meeting-classify-score.ts --runs 5 <docId>=signed
 *   npx tsx debug/meeting-classify-score.ts <docId>            # ungraded, just report
 */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";

import { geminiGenerateTextDetailed } from "../src/lib/gemini-generate-content.ts";
import { parseClassifyChoice } from "../supabase/functions/_shared/ai_flows/engine.ts";
import {
  buildMeetingClassifyPrompt,
  MEETING_OUTCOME_CATEGORIES,
  splitMeetingContent
} from "../src/lib/meetings/outcome-core.ts";

loadEnv();

const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
if (!apiKey) throw new Error("GOOGLE_API_KEY missing from .env");

const args = process.argv.slice(2);
const runsFlag = args.indexOf("--runs");
const runs = runsFlag >= 0 ? Number(args[runsFlag + 1]) : 3;
// Skip the flag and its value by INDEX, and only when the flag is present:
// `indexOf` answers -1 when it is not, and `i !== -1 + 1` quietly ate the
// first document id on the documented default invocation (Bugbot, PR #1626).
const flagIndexes = new Set(runsFlag >= 0 ? [runsFlag, runsFlag + 1] : []);
const cases = args
  .filter((a, i) => !flagIndexes.has(i) && !a.startsWith("--"))
  .map((a) => {
    const [id, want] = a.split("=");
    return { id: id as string, want: want ?? null };
  });

if (cases.length === 0 || !Number.isFinite(runs) || runs < 1) {
  console.error("usage: npx tsx debug/meeting-classify-score.ts [--runs N] <docId>[=expected] ...");
  process.exit(1);
}

// The model resolution the classifier itself uses, so the probe cannot drift
// onto a different model than production.
const model = (process.env.GEMINI_SUMMARY_MODEL ?? "").trim() || "gemini-3.5-flash-lite";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
);

async function classifyOnce(contentMd: string): Promise<string> {
  const { text } = await geminiGenerateTextDetailed({
    apiKey,
    model,
    systemInstruction:
      "You read the record of a business meeting and report what the meeting was, strictly and conservatively. You never infer a commitment that was not made.",
    userText: buildMeetingClassifyPrompt(contentMd),
    temperature: 0.1,
    maxOutputTokens: 1000
  });
  return parseClassifyChoice(
    text,
    MEETING_OUTCOME_CATEGORIES.map((c) => ({ value: c.value }))
  );
}

let graded = 0;
let hits = 0;

console.log(`model=${model}  runs=${runs}\n`);

for (const { id, want } of cases) {
  const { data, error } = await db
    .from("business_documents")
    .select("title, content_md")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    console.log(`${id}  NOT FOUND${error ? ` (${error.message})` : ""}`);
    continue;
  }
  const contentMd = (data.content_md as string) ?? "";
  const { minutes, transcript } = splitMeetingContent(contentMd);
  const answers: string[] = [];
  for (let i = 0; i < runs; i += 1) answers.push(await classifyOnce(contentMd));

  const unique = new Set(answers);
  const line = [
    (data.title as string).slice(0, 46).padEnd(48),
    `minutes=${String(minutes.length).padStart(5)}`,
    `transcript=${String(transcript.length).padStart(5)}`,
    `-> ${answers.join(",")}`
  ].join("  ");
  if (want) {
    graded += runs;
    const hit = answers.filter((a) => a === want).length;
    hits += hit;
    console.log(`${line}   want=${want} ${hit}/${runs}${hit === runs ? "" : "  MISS"}`);
  } else {
    console.log(line);
  }
  // A classifier that answers differently on identical input is the failure
  // mode that reads as "the AI is being vague": worth naming even when the
  // modal answer happens to be right.
  if (unique.size > 1) console.log(`${" ".repeat(48)}  UNSTABLE: ${unique.size} distinct answers`);
}

if (graded > 0) console.log(`\nScore: ${hits}/${graded}`);
