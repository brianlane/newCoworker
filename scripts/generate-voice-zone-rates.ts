/**
 * Regenerate `src/lib/plans/voice-zone-rates.generated.ts` from a Telnyx
 * "Global Voice Conversational" rate deck CSV.
 *
 * WHY THIS EXISTS AS A GENERATOR RATHER THAN A COMMITTED CSV: the deck is
 * ~35 MB and 262k rows, of which only the ~22k NANP rows can ever price one
 * of our calls. Committing the raw file would put a 35 MB blob in every
 * clone to carry 155 KB of signal. The generated module IS the diffable
 * baseline: when the next deck lands, regenerate and read the git diff to
 * see exactly which prefixes changed zone. Telnyx never sends a diff of its
 * own (it emails only the new deck), so this is the only way to answer
 * "what actually changed?".
 *
 * THE DECK IS NOT FETCHABLE. It arrives as an emailed link behind a
 * portal.telnyx.com session, so no automation can refresh this table. A
 * human downloads the CSV and runs:
 *
 *   npx tsx scripts/generate-voice-zone-rates.ts ~/Downloads/<deck>.csv
 *
 * Only US and CA rows are kept. Everything else in the deck is real, but we
 * do not originate calls to it: international voice would need a separate
 * decision about whether to allow it at all, and inventing a rate table for
 * traffic we do not send would be a table nobody validates. Non-NANP
 * destinations therefore resolve to `null` and callers fall back to their
 * own assumption, which is honest about not knowing.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Deck columns we read. The deck carries ten; the rest are informational. */
type DeckRow = {
  iso: string;
  destinationPrefix: string;
  description: string;
  rate: string;
};

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "src/lib/plans/voice-zone-rates.generated.ts"
);

/**
 * Split one CSV line, honouring the double-quoted fields the deck uses for
 * Country and Description. No escaped-quote handling: the deck has none, and
 * a parser that silently mangles a field it does not understand is worse
 * than one that is only claimed to handle the shape in front of it.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function parseDeck(csv: string): DeckRow[] {
  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "");
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`deck is missing the "${name}" column`);
    return i;
  };
  const iIso = col("ISO");
  const iDest = col("Destination Prefixes");
  const iDesc = col("Description");
  const iRate = col("Rate");

  const rows: DeckRow[] = [];
  for (let n = 1; n < lines.length; n += 1) {
    const line = lines[n];
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    rows.push({
      iso: f[iIso] ?? "",
      destinationPrefix: (f[iDest] ?? "").trim(),
      description: f[iDesc] ?? "",
      rate: (f[iRate] ?? "").trim()
    });
  }
  return rows;
}

/**
 * The zone label, taken from the tail of the deck's Description.
 *
 *   "Trunking Outbound Minute - United States - High Cost (Zone 5)"
 *      -> "High Cost (Zone 5)"
 *   "Trunking Outbound Minute - Canada (Zone 2)"
 *      -> "Canada (Zone 2)"
 *
 * Splitting on the FIRST three " - " separators and keeping the remainder
 * means a label that itself contains " - " survives intact.
 */
function zoneLabel(description: string): string {
  return description.split(" - ", 4).slice(-1)[0] ?? description;
}

function main(): void {
  const deckPath = process.argv[2];
  if (!deckPath) {
    console.error(
      "usage: npx tsx scripts/generate-voice-zone-rates.ts <global_conversational_deck.csv>"
    );
    process.exit(1);
  }

  const raw = readFileSync(deckPath);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const rows = parseDeck(raw.toString("utf8"));

  // zoneKey -> { iso, label, cents, prefixes }. One entry per distinct
  // (iso, label, rate): the deck repeats the same zone across thousands of
  // prefixes, and collapsing them is what turns 22k rows into 13 zones.
  const zones = new Map<
    string,
    { iso: string; label: string; cents: number; prefixes: string[] }
  >();
  let nanpRows = 0;
  // Every NANP row the loop refuses, reported at the end. A generator that
  // silently narrows its own input is how a table ends up quietly wrong.
  const skipped: string[] = [];

  for (const row of rows) {
    if (row.iso !== "US" && row.iso !== "CA") continue;
    // Deck prefixes carry the NANP country code, so "1602824" is
    // +1 (602) 824. Two shapes beyond a plain prefix have to survive here,
    // and dropping either silently is a real bug rather than tidying:
    //
    //   "1"        the NANP CATCH-ALL at Zone 1. Every +1 number not named
    //              by a longer row falls to it, which is why an unlisted
    //              number resolves to $0.005 instead of to "unknown".
    //   "1XXX310"  a WILDCARD, X = any digit. Canada prices its N11 service
    //              codes (211/311/411/511/611/711) this way, at 75c/min.
    //
    // A `/^1\d+$/` test quietly drops both, leaving a table that looks
    // complete and answers "unknown" for every unlisted US number.
    if (!/^1[\dX]*$/.test(row.destinationPrefix)) {
      skipped.push(row.destinationPrefix);
      continue;
    }
    const rate = Number(row.rate);
    if (!Number.isFinite(rate)) {
      skipped.push(row.destinationPrefix);
      continue;
    }
    nanpRows += 1;

    const label = zoneLabel(row.description);
    // Rates are quoted in dollars per minute to 4 decimals; the codebase
    // costs everything in cents, so convert once here rather than at every
    // call site. Round to 4 decimal cents to kill float dust like
    // 0.181 * 100 = 18.099999999999998.
    const cents = Math.round(rate * 100 * 10_000) / 10_000;
    const key = `${row.iso}|${label}|${cents}`;
    const existing = zones.get(key);
    if (existing) {
      existing.prefixes.push(row.destinationPrefix);
    } else {
      zones.set(key, { iso: row.iso, label, cents, prefixes: [row.destinationPrefix] });
    }
  }

  if (nanpRows === 0) {
    throw new Error(
      `no US/CA rows found in ${deckPath}: wrong deck, or the column layout changed`
    );
  }

  // Deterministic ordering so a regeneration produces a reviewable diff
  // rather than a reshuffle: zones by ISO then label, prefixes numerically
  // within each zone.
  const ordered = [...zones.values()].sort(
    (a, b) => a.iso.localeCompare(b.iso) || a.label.localeCompare(b.label)
  );
  for (const zone of ordered) zone.prefixes.sort();

  const entries = ordered
    .map((zone) => {
      // 12 prefixes per line keeps the generated file diffable: a changed
      // prefix shows as one changed line, not one changed 150 KB line.
      const chunks: string[] = [];
      for (let i = 0; i < zone.prefixes.length; i += 12) {
        const isLast = i + 12 >= zone.prefixes.length;
        // The TRAILING SPACE is load-bearing. These chunks are concatenated
        // with `+` at parse time, so without it the last prefix of one line
        // and the first of the next fuse into one junk token
        // ("1480306" + "1602825" = "14803061602825"), silently deleting both
        // and dropping the call to whatever shorter prefix still matches.
        chunks.push(
          `      "${zone.prefixes.slice(i, i + 12).join(" ")}${isLast ? "" : " "}"`
        );
      }
      return [
        `  {`,
        `    iso: "${zone.iso}",`,
        `    label: ${JSON.stringify(zone.label)},`,
        `    centsPerMinute: ${zone.cents},`,
        `    prefixes:`,
        chunks.join(" +\n"),
        `  }`
      ].join("\n");
    })
    .join(",\n");

  const file = `/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Telnyx "Global Voice Conversational" outbound termination rates for the
 * NANP (US + CA), which is every destination we dial. Regenerate with:
 *
 *   npx tsx scripts/generate-voice-zone-rates.ts <deck.csv>
 *
 * Source deck: ${path.basename(deckPath)}
 * sha256:      ${sha256}
 * NANP rows:   ${nanpRows.toLocaleString("en-US")} across ${ordered.length} zones
 *
 * Prefixes are space-separated inside one string per zone rather than a
 * string[]: the array form costs two bytes of quoting and a comma per
 * entry, which on ${nanpRows.toLocaleString("en-US")} prefixes is most of the file. They carry the
 * NANP country code ("1602824" is +1 602 824) and are matched
 * longest-first, so a 7 digit NPA-NXX row always beats the 4 digit NPA
 * default it sits inside.
 */

export type VoiceRateZone = {
  /** "US" or "CA". */
  iso: string;
  /** The deck's zone name, e.g. "High Cost (Zone 5)". */
  label: string;
  /** Termination cost in CENTS per minute. */
  centsPerMinute: number;
  /** Space-separated dial prefixes, country code included. */
  prefixes: string;
};

export const VOICE_RATE_DECK_SHA256 = "${sha256}";

export const VOICE_RATE_ZONES: readonly VoiceRateZone[] = [
${entries}
];
`;

  // ROUND-TRIP THE EMITTED TABLE before writing it. The first version of
  // this generator concatenated its wrapped lines without a separator,
  // fusing one prefix per line boundary into a junk token. Every affected
  // number then quietly fell through to a shorter prefix and priced at the
  // baseline, which is exactly the failure the table exists to prevent and
  // is invisible in a 200 KB diff. Counting the tokens back out of the
  // generated text catches it at generation time.
  const emitted = [...file.matchAll(/prefixes:\n([\s\S]*?)\n {2}\}/g)].map((match) =>
    match[1]
      .split(" +\n")
      .map((line) => line.trim().replace(/^"|"$/g, ""))
      .join("")
      .split(" ")
      .filter(Boolean)
  );
  const emittedCount = emitted.reduce((sum, list) => sum + list.length, 0);
  if (emittedCount !== nanpRows) {
    throw new Error(
      `generated table round-trips to ${emittedCount} prefixes but the deck had ${nanpRows}: the emitter is corrupting prefixes at line boundaries`
    );
  }
  const malformed = emitted.flat().filter((prefix) => !/^1[\dX]*$/.test(prefix));
  if (malformed.length > 0) {
    throw new Error(
      `generated table contains ${malformed.length} malformed prefix(es), e.g. ${malformed.slice(0, 3).join(", ")}`
    );
  }

  writeFileSync(OUTPUT_PATH, file);
  console.log(`wrote ${OUTPUT_PATH}`);
  console.log(`  verified ${emittedCount.toLocaleString("en-US")} prefixes round-trip`);
  console.log(`  deck    ${path.basename(deckPath)} (sha256 ${sha256.slice(0, 12)}...)`);
  console.log(`  zones   ${ordered.length}`);
  console.log(`  rows    ${nanpRows.toLocaleString("en-US")}`);
  for (const zone of ordered) {
    console.log(
      `    ${zone.iso} ${zone.label.padEnd(26)} ${String(zone.cents).padStart(7)}c/min  ${zone.prefixes.length} prefixes`
    );
  }
  if (skipped.length > 0) {
    console.log(`  SKIPPED ${skipped.length} NANP row(s) this generator does not model:`);
    for (const prefix of [...new Set(skipped)]) console.log(`    ${prefix}`);
  }
}

main();
