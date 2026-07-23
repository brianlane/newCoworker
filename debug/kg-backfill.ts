/**
 * kg-backfill — build a tenant's memory knowledge graph from the memory it
 * already has (`business_configs.memory_md` + `memory_archive_md`).
 *
 *   npx tsx debug/kg-backfill.ts                      # HQ tenant, DRY RUN
 *   npx tsx debug/kg-backfill.ts --business <uuid>    # dry run for a tenant
 *   npx tsx debug/kg-backfill.ts --business <uuid> --apply
 *   npx tsx debug/kg-backfill.ts --business <uuid> --sources voice,sms,email \
 *     [--limit-customers 20] [--apply]                # conversational replay
 *
 * --sources replays HISTORICAL conversation windows (voice transcripts, SMS
 * threads, linked-contact email) through the CUSTOMER-source extraction
 * prompt — per identified customer, trust 1, attributed to the customer —
 * exactly what the live summarizer hook does, so the widened graph is fully
 * inspectable offline before any tenant's live traffic feeds it.
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
const sourcesFlag = args.indexOf("--sources");
const SOURCES = new Set(
  sourcesFlag >= 0 ? (args[sourcesFlag + 1] ?? "").split(",").map((s) => s.trim()) : []
);
const limitFlag = args.indexOf("--limit-customers");
const rawLimit = limitFlag >= 0 ? Number.parseInt(args[limitFlag + 1] ?? "", 10) : NaN;
const LIMIT_CUSTOMERS = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;

const BATCH_SIZE = 15;

/** Replay historical conversation windows through the customer prompt. */
async function backfillConversations(businessId: string, apiKey: string): Promise<void> {
  const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
  const { geminiGenerateTextDetailed } = await import("../src/lib/gemini-generate-content.ts");
  const {
    CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT,
    composeConversationExtractionInput,
    parseGraphExtraction
  } = await import("../src/lib/memory/graph-extract.ts");
  const { applyGraphExtraction } = await import("../src/lib/memory/graph-write.ts");
  const { listMemoryEntities } = await import("../src/lib/memory/graph-db.ts");
  const { listVoiceTurnsForCustomer } = await import("../src/lib/db/voice-transcripts.ts");
  const { listSmsHistoryForCustomer } = await import("../src/lib/customer-memory/db.ts");
  const { listEmailLogForAddress } = await import("../src/lib/db/email-log.ts");
  const { dominantConversationSource } = await import("../src/lib/memory/graph-conversational.ts");

  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("contacts")
    .select("customer_e164, display_name, email, interaction_count")
    .eq("business_id", businessId)
    .gt("interaction_count", 0)
    .order("interaction_count", { ascending: false })
    .limit(LIMIT_CUSTOMERS);
  if (error) throw new Error(`contacts read: ${error.message}`);
  const contacts = (data ?? []) as Array<{
    customer_e164: string;
    display_name: string | null;
    email: string | null;
  }>;
  console.log(
    `[kg-backfill] conversational replay: ${contacts.length} customers ` +
      `(sources=${[...SOURCES].join(",")}, apply=${APPLY})`
  );
  const model = (process.env.MEMORY_GRAPH_EXTRACT_MODEL ?? "").trim() || "gemini-3.5-flash-lite";

  for (const contact of contacts) {
    const sections: string[] = [];
    let voiceTurns = 0;
    let smsTurns = 0;
    let emails = 0;
    if (SOURCES.has("voice")) {
      const turns = await listVoiceTurnsForCustomer(businessId, contact.customer_e164, {
        maxCalls: 5
      });
      voiceTurns = turns.length;
      if (turns.length > 0) {
        sections.push(
          "VOICE CALLS (oldest first):",
          turns.map((t) => `${t.role}: ${t.content}`).join("\n"),
          ""
        );
      }
    }
    if (SOURCES.has("sms")) {
      const history = await listSmsHistoryForCustomer(businessId, contact.customer_e164, {
        limit: 40
      });
      smsTurns = history.length;
      if (history.length > 0) {
        sections.push(
          "SMS EXCHANGES (oldest first):",
          history
            .map((h) => `customer: ${h.inboundText}\nassistant: ${h.assistantReply ?? ""}`)
            .join("\n"),
          ""
        );
      }
    }
    if (SOURCES.has("email") && contact.email) {
      const mail = await listEmailLogForAddress(businessId, contact.email, { limit: 10 });
      emails = mail.length;
      if (mail.length > 0) {
        sections.push(
          "EMAILS (oldest first):",
          mail
            .slice()
            .reverse()
            .map(
              (m) => `${m.direction}: ${m.subject ?? ""} — ${(m.body_preview ?? "").slice(0, 500)}`
            )
            .join("\n")
        );
      }
    }
    const transcript = sections.join("\n").trim();
    if (!transcript) continue;

    const indexRows = APPLY ? await listMemoryEntities(businessId) : [];
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
      systemInstruction: CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT,
      userText: composeConversationExtractionInput(transcript.slice(-24_000), entityIndex),
      temperature: 0,
      maxOutputTokens: 2000,
      responseMimeType: "application/json"
    });
    const extraction = parseGraphExtraction(text, 1);
    const source = dominantConversationSource({ voiceTurns, smsTurns, emails });
    console.log(
      `[kg-backfill] ${contact.customer_e164} (${contact.display_name ?? "unnamed"}) ` +
        `source=${source}: ${extraction.entities.length} entities, ${extraction.facts.length} facts`
    );
    if (!APPLY) {
      for (const e of extraction.entities) console.log(`  entity ${e.kind}: ${e.name}`);
      for (const f of extraction.facts) {
        console.log(
          `  fact: ${f.subjectRef} ${f.predicate} ${f.objectRef ?? JSON.stringify(f.objectValue)}`
        );
      }
      continue;
    }
    if (extraction.entities.length === 0) continue;
    const result = await applyGraphExtraction(businessId, extraction, [transcript], {}, {
      source,
      trust: 1,
      attributedTo: contact.customer_e164
    });
    console.log(`  applied: ${JSON.stringify(result)}`);
  }
  console.log(
    APPLY
      ? "[kg-backfill] conversational replay DONE"
      : "[kg-backfill] conversational dry run complete — re-run with --apply to write"
  );
}

async function main(): Promise<void> {
  if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
    throw new Error(`--business must be a uuid (got: ${BUSINESS_ID})`);
  }
  const apiKey = process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) throw new Error("GOOGLE_API_KEY missing from .env (internal-ci-debug key)");

  if (SOURCES.size > 0) {
    await backfillConversations(BUSINESS_ID, apiKey);
    return;
  }

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

    // kg-source: backfill — historical memory_md replays at owner trust.
    const result = await applyGraphExtraction(BUSINESS_ID, extraction, batch, {}, {
      source: "backfill",
      trust: 3,
      attributedTo: null
    });
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
