/**
 * kg-backfill — build a tenant's memory knowledge graph from the memory it
 * already has (`business_configs.memory_md` + `memory_archive_md`).
 *
 *   npx tsx debug/kg-backfill.ts                      # HQ tenant, DRY RUN
 *   npx tsx debug/kg-backfill.ts --business <uuid>    # dry run for a tenant
 *   npx tsx debug/kg-backfill.ts --business <uuid> --apply
 *
 * Dry run prints exactly what WOULD be created/merged; --apply lands it
 * through the same resolution/supersedence write path live capture uses
 * (src/lib/memory/graph-write.ts), so re-running is idempotent: already-
 * known entities resolve instead of duplicating, already-recorded facts
 * skip.
 *
 * Spend: extraction runs on the laptop `.env`'s GOOGLE_API_KEY — the
 * engineering `internal-ci-debug` key per docs/GEMINI-SPEND.md — and is
 * deliberately NOT metered into the tenant's AI budget (this is an
 * operational backfill, not tenant traffic). Nothing here sends any SMS,
 * email, or notification.
 *
 * NOTE: this script does not require memory_graph_mode to be set — backfill
 * before flipping a tenant to shadow is the intended order.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const bizFlag = args.indexOf("--business");
const HQ_TENANT = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const BUSINESS_ID = bizFlag >= 0 ? args[bizFlag + 1] : HQ_TENANT;

const BATCH_SIZE = 15;

async function main(): Promise<void> {
  if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
    throw new Error(`--business must be a uuid (got: ${BUSINESS_ID})`);
  }
  const apiKey = process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) throw new Error("GOOGLE_API_KEY missing from .env (internal-ci-debug key)");

  const { getBusinessConfig } = await import("../src/lib/db/configs.ts");
  const { extractExistingBullets } = await import("../src/lib/dashboard-chat/memory-capture.ts");
  const { geminiGenerateTextDetailed } = await import("../src/lib/gemini-generate-content.ts");
  const {
    GRAPH_EXTRACTION_SYSTEM_PROMPT,
    composeGraphExtractionInput,
    parseGraphExtraction
  } = await import("../src/lib/memory/graph-extract.ts");
  const { applyGraphExtraction } = await import("../src/lib/memory/graph-write.ts");
  const { listMemoryEntities } = await import("../src/lib/memory/graph-db.ts");

  const config = await getBusinessConfig(BUSINESS_ID);
  if (!config) throw new Error(`no business_configs row for ${BUSINESS_ID}`);

  const activeBullets = extractExistingBullets(config.memory_md ?? "");
  const archiveBullets = extractExistingBullets(config.memory_archive_md ?? "");
  // Archive first: it holds the OLDEST facts, so supersedence lands newer
  // values (active memory) on top, matching real capture order.
  const bullets = [...archiveBullets, ...activeBullets];
  console.log(
    `[kg-backfill] business=${BUSINESS_ID} bullets=${bullets.length} ` +
      `(archive=${archiveBullets.length}, active=${activeBullets.length}) apply=${APPLY}`
  );
  if (bullets.length === 0) {
    console.log("[kg-backfill] nothing to do — memory holds no bullet lines");
    return;
  }

  const model = (process.env.MEMORY_GRAPH_EXTRACT_MODEL ?? "").trim() || "gemini-3.5-flash-lite";
  const totals = {
    entitiesCreated: 0,
    entitiesMerged: 0,
    factsInserted: 0,
    factsSuperseded: 0,
    factsSkipped: 0
  };

  for (let start = 0; start < bullets.length; start += BATCH_SIZE) {
    const batch = bullets.slice(start, start + BATCH_SIZE);
    // Refresh the index per batch so later batches resolve against entities
    // earlier batches created (only meaningful with --apply).
    const indexRows = APPLY ? await listMemoryEntities(BUSINESS_ID) : [];
    const entityIndex = indexRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.canonical_name,
      aliases: row.aliases,
      phones: row.phones,
      emails: row.emails
    }));

    const { text } = await geminiGenerateTextDetailed({
      apiKey,
      model,
      systemInstruction: GRAPH_EXTRACTION_SYSTEM_PROMPT,
      userText: composeGraphExtractionInput(batch, entityIndex),
      temperature: 0,
      maxOutputTokens: 2000,
      responseMimeType: "application/json"
    });
    const extraction = parseGraphExtraction(text, batch.length);
    console.log(
      `[kg-backfill] batch ${start / BATCH_SIZE + 1}: ${batch.length} bullets → ` +
        `${extraction.entities.length} entities, ${extraction.facts.length} facts`
    );

    if (!APPLY) {
      for (const e of extraction.entities) {
        console.log(
          `  entity ${e.kind}: ${e.name}` +
            (e.phones.length ? ` phones=[${e.phones.join(", ")}]` : "") +
            (e.emails.length ? ` emails=[${e.emails.join(", ")}]` : "") +
            (e.existingId ? ` → matches ${e.existingId}` : "")
        );
      }
      for (const f of extraction.facts) {
        console.log(
          `  fact: ${f.subjectRef} ${f.predicate} ${f.objectRef ?? JSON.stringify(f.objectValue)}`
        );
      }
      continue;
    }

    const result = await applyGraphExtraction(BUSINESS_ID, extraction, batch);
    totals.entitiesCreated += result.entitiesCreated;
    totals.entitiesMerged += result.entitiesMerged;
    totals.factsInserted += result.factsInserted;
    totals.factsSuperseded += result.factsSuperseded;
    totals.factsSkipped += result.factsSkipped;
    console.log(`  applied: ${JSON.stringify(result)}`);
  }

  if (APPLY) {
    console.log(`[kg-backfill] DONE ${JSON.stringify(totals)}`);
  } else {
    console.log("[kg-backfill] dry run complete — re-run with --apply to write");
  }
}

main().catch((err) => {
  console.error("[kg-backfill] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
