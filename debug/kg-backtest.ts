/**
 * kg-backtest — replay a tenant's REAL history against the knowledge graph
 * before any live rollout. Read-only by construction:
 *
 *   - Zero Supabase writes: the graph is built in a LOCAL throwaway SQLite
 *     database (node:sqlite, in-memory) through the exact same
 *     resolution/supersedence logic production uses
 *     (applyGraphExtraction with injected local IO).
 *   - Zero sends: nothing here touches SMS/email/notification paths.
 *   - Gemini extraction bills the laptop `.env` GOOGLE_API_KEY — the
 *     engineering `internal-ci-debug` key (docs/GEMINI-SPEND.md) — never
 *     the tenant's AI budget.
 *
 * Phases:
 *   1. BUILD — the tenant's saved memory bullets (memory_md + archive,
 *      oldest first), optionally their raw owner chat turns
 *      (--replay-chat, runs the capture classifier first), and optionally
 *      their historical CONVERSATION windows (--sources voice,sms,email —
 *      per identified customer through the CUSTOMER-source extraction
 *      prompt at trust 1, exactly what the live summarizer hook does) are
 *      extracted into the local graph.
 *   2. REPLAY — real caller questions from voice_call_transcript_turns run
 *      through BOTH retrieval paths: the ranked-markdown selection
 *      (selectMemoryForQuestion) and graph retrieval over the local store
 *      (retrieveGraphContext with injected IO), caller-scoped when the
 *      transcript has a caller number.
 *
 * Output: a side-by-side JSON report in test-results/ plus a console
 * summary (per-question context sizes, entity/fact hits, fallbacks).
 *
 *   npx tsx debug/kg-backtest.ts                          # HQ tenant
 *   npx tsx debug/kg-backtest.ts --business <uuid>        # e.g. Amy
 *   npx tsx debug/kg-backtest.ts --business <uuid> --replay-chat --max-turns 40
 *   npx tsx debug/kg-backtest.ts --business <uuid> \
 *     --sources voice,sms,email --limit-customers 20      # widened graph
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadEnv } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2);
// A flag's value is the next token ONLY when it isn't itself a flag —
// `--max-turns --replay-chat` must not read "--replay-chat" as the value.
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : undefined;
};
const intFlag = (name: string, fallback: number): number => {
  const parsed = Number(flag(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const HQ_TENANT = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const BUSINESS_ID = flag("business") ?? HQ_TENANT;
const REPLAY_CHAT = args.includes("--replay-chat");
const MAX_TURNS = intFlag("max-turns", 30);
const MAX_QUESTIONS = intFlag("max-questions", 25);
/** Widened-graph build: replay these conversational sources (voice,sms,email). */
const SOURCES = new Set(
  (flag("sources") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const LIMIT_CUSTOMERS = intFlag("limit-customers", 20);
const BATCH_SIZE = 15;

/**
 * Local throwaway graph store (in-memory SQLite) implementing the same IO
 * surface the production write/retrieval paths inject — the schema mirrors
 * supabase/migrations/20260820100100_memory_graph.sql.
 */
class LocalGraphStore {
  private db: DatabaseSync;
  private nextId = 1;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`
      create table memory_entities (
        id text primary key,
        business_id text not null,
        kind text not null,
        canonical_name text not null,
        aliases text not null default '[]',
        phones text not null default '[]',
        emails text not null default '[]',
        customer_e164 text,
        source text not null default 'owner_chat',
        trust integer not null default 3,
        attributed_to text,
        created_at text not null,
        updated_at text not null
      );
      create table memory_facts (
        id text primary key,
        business_id text not null,
        subject_entity_id text not null,
        predicate text not null,
        object_entity_id text,
        object_value text,
        source_text text not null,
        stated_at text not null,
        active integer not null default 1,
        superseded_by text,
        source text not null default 'owner_chat',
        trust integer not null default 3,
        attributed_to text,
        created_at text not null
      );
    `);
  }

  private mintId(prefix: string): string {
    const n = String(this.nextId++).padStart(12, "0");
    return `${prefix}0000-0000-4000-8000-${n}`.slice(prefix.length);
  }

  listEntities = async (businessId: string) => {
    const rows = this.db
      .prepare("select * from memory_entities where business_id = ?")
      .all(businessId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      business_id: String(r.business_id),
      kind: String(r.kind),
      canonical_name: String(r.canonical_name),
      aliases: JSON.parse(String(r.aliases)) as string[],
      phones: JSON.parse(String(r.phones)) as string[],
      emails: JSON.parse(String(r.emails)) as string[],
      customer_e164: r.customer_e164 === null ? null : String(r.customer_e164),
      source: String(r.source),
      trust: Number(r.trust),
      attributed_to: r.attributed_to === null ? null : String(r.attributed_to),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at)
    }));
  };

  insertEntity = async (entity: {
    business_id: string;
    kind: string;
    canonical_name: string;
    aliases: string[];
    phones: string[];
    emails: string[];
    source?: string;
    trust?: number;
    attributed_to?: string | null;
  }) => {
    const id = this.mintId("e");
    const now = new Date().toISOString();
    const source = entity.source ?? "owner_chat";
    const trust = entity.trust ?? 3;
    const attributedTo = entity.attributed_to ?? null;
    this.db
      .prepare(
        `insert into memory_entities (id, business_id, kind, canonical_name, aliases, phones, emails, source, trust, attributed_to, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        entity.business_id,
        entity.kind,
        entity.canonical_name,
        JSON.stringify(entity.aliases),
        JSON.stringify(entity.phones),
        JSON.stringify(entity.emails),
        source,
        trust,
        attributedTo,
        now,
        now
      );
    return {
      id,
      business_id: entity.business_id,
      kind: entity.kind,
      canonical_name: entity.canonical_name,
      aliases: entity.aliases,
      phones: entity.phones,
      emails: entity.emails,
      customer_e164: null,
      source,
      trust,
      attributed_to: attributedTo,
      created_at: now,
      updated_at: now
    };
  };

  updateEntity = async (
    id: string,
    patch: { aliases?: string[]; phones?: string[]; emails?: string[]; trust?: number }
  ) => {
    if (patch.trust !== undefined) {
      this.db.prepare("update memory_entities set trust = ? where id = ?").run(patch.trust, id);
    }
    if (patch.aliases) {
      this.db
        .prepare("update memory_entities set aliases = ? where id = ?")
        .run(JSON.stringify(patch.aliases), id);
    }
    if (patch.phones) {
      this.db
        .prepare("update memory_entities set phones = ? where id = ?")
        .run(JSON.stringify(patch.phones), id);
    }
    if (patch.emails) {
      this.db
        .prepare("update memory_entities set emails = ? where id = ?")
        .run(JSON.stringify(patch.emails), id);
    }
  };

  private mapFact(r: Record<string, unknown>) {
    return {
      id: String(r.id),
      business_id: String(r.business_id),
      subject_entity_id: String(r.subject_entity_id),
      predicate: String(r.predicate),
      object_entity_id: r.object_entity_id === null ? null : String(r.object_entity_id),
      object_value: r.object_value === null ? null : String(r.object_value),
      source_text: String(r.source_text),
      stated_at: String(r.stated_at),
      active: Number(r.active) === 1,
      superseded_by: r.superseded_by === null ? null : String(r.superseded_by),
      source: String(r.source),
      trust: Number(r.trust),
      attributed_to: r.attributed_to === null ? null : String(r.attributed_to),
      created_at: String(r.created_at)
    };
  }

  listFacts = async (businessId: string, subjectEntityId: string, predicate: string) => {
    const rows = this.db
      .prepare(
        "select * from memory_facts where business_id = ? and subject_entity_id = ? and predicate = ? and active = 1"
      )
      .all(businessId, subjectEntityId, predicate) as Record<string, unknown>[];
    return rows.map((r) => this.mapFact(r));
  };

  listActiveFactsForBusiness = async (businessId: string) => {
    const rows = this.db
      .prepare("select * from memory_facts where business_id = ? and active = 1")
      .all(businessId) as Record<string, unknown>[];
    return rows.map((r) => this.mapFact(r));
  };

  insertFact = async (fact: {
    business_id: string;
    subject_entity_id: string;
    predicate: string;
    object_entity_id?: string | null;
    object_value?: string | null;
    source_text: string;
    source?: string;
    trust?: number;
    attributed_to?: string | null;
  }) => {
    const id = this.mintId("f");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into memory_facts (id, business_id, subject_entity_id, predicate, object_entity_id, object_value, source_text, source, trust, attributed_to, stated_at, active, superseded_by, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, null, ?)`
      )
      .run(
        id,
        fact.business_id,
        fact.subject_entity_id,
        fact.predicate,
        fact.object_entity_id ?? null,
        fact.object_value ?? null,
        fact.source_text,
        fact.source ?? "owner_chat",
        fact.trust ?? 3,
        fact.attributed_to ?? null,
        now,
        now
      );
    return this.mapFact(
      this.db.prepare("select * from memory_facts where id = ?").get(id) as Record<string, unknown>
    );
  };

  supersedeFacts = async (ids: string[], supersededBy: string) => {
    const stmt = this.db.prepare(
      "update memory_facts set active = 0, superseded_by = ? where id = ?"
    );
    for (const id of ids) stmt.run(supersededBy, id);
  };

  touchFact = async (id: string) => {
    this.db
      .prepare("update memory_facts set stated_at = ? where id = ?")
      .run(new Date().toISOString(), id);
  };

  counts(): { entities: number; activeFacts: number; supersededFacts: number } {
    const e = this.db.prepare("select count(*) as n from memory_entities").get() as { n: number };
    const fa = this.db
      .prepare("select count(*) as n from memory_facts where active = 1")
      .get() as { n: number };
    const fs_ = this.db
      .prepare("select count(*) as n from memory_facts where active = 0")
      .get() as { n: number };
    return { entities: e.n, activeFacts: fa.n, supersededFacts: fs_.n };
  }
}

async function main(): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
    throw new Error(`--business must be a uuid (got: ${BUSINESS_ID})`);
  }
  const apiKey = process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) throw new Error("GOOGLE_API_KEY missing from .env (internal-ci-debug key)");

  const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
  const { getBusinessConfig } = await import("../src/lib/db/configs.ts");
  const { extractExistingBullets, OWNER_MEMORY_SYSTEM_PROMPT, composeExtractionInput, parseMemoryExtraction } =
    await import("../src/lib/dashboard-chat/memory-capture.ts");
  const { geminiGenerateTextDetailed } = await import("../src/lib/gemini-generate-content.ts");
  const { GRAPH_EXTRACTION_SYSTEM_PROMPT, composeGraphExtractionInput, parseGraphExtraction } =
    await import("../src/lib/memory/graph-extract.ts");
  const { applyGraphExtraction } = await import("../src/lib/memory/graph-write.ts");
  const { retrieveGraphContext } = await import("../src/lib/memory/graph-retrieval.ts");
  const { selectMemoryForQuestion } = await import("../src/lib/memory/retrieval.ts");

  const db = await createSupabaseServiceClient();
  const config = await getBusinessConfig(BUSINESS_ID);
  if (!config) throw new Error(`no business_configs row for ${BUSINESS_ID}`);

  const store = new LocalGraphStore();
  const model = (process.env.MEMORY_GRAPH_EXTRACT_MODEL ?? "").trim() || "gemini-3.5-flash-lite";

  const extractBatch = async (bullets: string[]): Promise<void> => {
    for (let start = 0; start < bullets.length; start += BATCH_SIZE) {
      const batch = bullets.slice(start, start + BATCH_SIZE);
      const indexRows = await store.listEntities(BUSINESS_ID);
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
      const result = await applyGraphExtraction(BUSINESS_ID, extraction, batch, {
        listEntities: store.listEntities,
        insertEntity: store.insertEntity as never,
        updateEntity: store.updateEntity,
        listFacts: store.listFacts,
        insertFact: store.insertFact as never,
        supersedeFacts: store.supersedeFacts,
        touchFact: store.touchFact
      });
      console.log(
        `[build] ${batch.length} bullets → +${result.entitiesCreated} entities, ` +
          `+${result.factsInserted} facts (${result.factsSuperseded} superseded)`
      );
    }
  };

  // ---- Phase 1: BUILD -------------------------------------------------
  const memoryMd = config.memory_md ?? "";
  const archiveMd = config.memory_archive_md ?? "";
  const bullets = [...extractExistingBullets(archiveMd), ...extractExistingBullets(memoryMd)];
  console.log(`[build] business=${BUSINESS_ID} memory bullets=${bullets.length}`);
  await extractBatch(bullets);

  let chatTurnsReplayed = 0;
  if (REPLAY_CHAT) {
    // Owner turns, oldest first, through the same capture classifier the
    // live paths run — matching production as closely as a replay can:
    // the CAPTURE model env (MEMORY_CAPTURE_MODEL, not the graph model),
    // the following assistant reply as reference-resolution context, and
    // existing memory bullets as the anti-duplication hint. One honest
    // divergence remains: existingBullets reflects memory as of TODAY, not
    // as of each historical turn (the per-turn state is unrecoverable).
    const captureModel =
      (process.env.MEMORY_CAPTURE_MODEL ?? "").trim() || "gemini-3.5-flash-lite";
    const existingBullets = extractExistingBullets(memoryMd);
    const { data: threads } = await db
      .from("dashboard_chat_threads")
      .select("id")
      .eq("business_id", BUSINESS_ID);
    const threadIds = (threads ?? []).map((t: { id: string }) => t.id);
    if (threadIds.length > 0) {
      const { data: messages } = await db
        .from("dashboard_chat_messages")
        .select("content, created_at, thread_id, role")
        .in("thread_id", threadIds)
        .order("created_at", { ascending: true })
        .limit(MAX_TURNS * 4);
      const rows = (messages ?? []) as Array<{
        content: string;
        thread_id: string;
        role: string;
      }>;
      for (let i = 0; i < rows.length && chatTurnsReplayed < MAX_TURNS; i += 1) {
        if (rows[i].role !== "user") continue;
        const ownerMessage = String(rows[i].content ?? "").trim();
        if (!ownerMessage) continue;
        // The assistant reply to THIS turn: the next assistant row in the
        // same thread (exactly what the live capture is handed).
        const reply = rows
          .slice(i + 1)
          .find((r) => r.thread_id === rows[i].thread_id && r.role === "assistant");
        const { text } = await geminiGenerateTextDetailed({
          apiKey,
          model: captureModel,
          systemInstruction: OWNER_MEMORY_SYSTEM_PROMPT,
          userText: composeExtractionInput(ownerMessage, {
            assistantReply: reply ? String(reply.content ?? "") : undefined,
            existingBullets
          }),
          temperature: 0,
          maxOutputTokens: 1000,
          responseMimeType: "application/json"
        });
        const capture = parseMemoryExtraction(text);
        chatTurnsReplayed += 1;
        if (capture.save && capture.bullets.length > 0) {
          console.log(`[replay-chat] captured ${capture.bullets.length} bullet(s)`);
          await extractBatch(capture.bullets);
        }
      }
    }
  }

  // Optional widened build: historical conversation windows through the
  // CUSTOMER-source prompt — the same per-identified-customer window shape
  // and trust-1 attributed provenance the live summarizer hook uses, so
  // the Phase-2 comparison runs over the graph a widened rollout WOULD
  // have built. Mirrors kg-backfill's --sources replay but lands in the
  // local throwaway store (zero Supabase writes).
  let conversationWindows = 0;
  if (SOURCES.size > 0) {
    const { CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT, composeConversationExtractionInput } =
      await import("../src/lib/memory/graph-extract.ts");
    const { dominantConversationSource } = await import(
      "../src/lib/memory/graph-conversational.ts"
    );
    const { listVoiceTurnsForCustomer } = await import("../src/lib/db/voice-transcripts.ts");
    const { listSmsHistoryForCustomer } = await import("../src/lib/customer-memory/db.ts");
    const { listEmailLogForAddress } = await import("../src/lib/db/email-log.ts");

    const { data: contactRows, error: contactsErr } = await db
      .from("contacts")
      .select("customer_e164, display_name, email, interaction_count")
      .eq("business_id", BUSINESS_ID)
      .gt("interaction_count", 0)
      .order("interaction_count", { ascending: false })
      .limit(LIMIT_CUSTOMERS);
    if (contactsErr) throw new Error(`contacts read: ${contactsErr.message}`);
    const contacts = (contactRows ?? []) as Array<{
      customer_e164: string;
      display_name: string | null;
      email: string | null;
    }>;
    console.log(
      `[build-sources] ${contacts.length} customers (sources=${[...SOURCES].join(",")})`
    );

    for (const contact of contacts) {
      const sections: string[] = [];
      let voiceTurns = 0;
      let smsTurns = 0;
      let emails = 0;
      // Same gate as the live summarizer (hasCustomerContent): only
      // CUSTOMER-authored material justifies an extraction — an
      // assistant-only window has nothing the customer stated, and running
      // it would both waste a Gemini call and skew the local graph with
      // content the live hook would never have extracted.
      let hasCustomerContent = false;
      if (SOURCES.has("voice")) {
        const turns = await listVoiceTurnsForCustomer(BUSINESS_ID, contact.customer_e164, {
          maxCalls: 5
        });
        voiceTurns = turns.length;
        if (turns.some((t) => t.role === "caller" && t.content.trim().length > 0)) {
          hasCustomerContent = true;
        }
        if (turns.length > 0) {
          sections.push(
            "VOICE CALLS (oldest first):",
            turns.map((t) => `${t.role}: ${t.content}`).join("\n"),
            ""
          );
        }
      }
      if (SOURCES.has("sms")) {
        const history = await listSmsHistoryForCustomer(BUSINESS_ID, contact.customer_e164, {
          limit: 40
        });
        smsTurns = history.length;
        if (history.some((h) => h.inboundText.trim().length > 0)) {
          hasCustomerContent = true;
        }
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
        const mail = await listEmailLogForAddress(BUSINESS_ID, contact.email, { limit: 10 });
        emails = mail.length;
        if (mail.some((m) => m.direction === "inbound")) {
          hasCustomerContent = true;
        }
        if (mail.length > 0) {
          sections.push(
            "EMAILS (oldest first):",
            mail
              .slice()
              .reverse()
              .map(
                (m) =>
                  `${m.direction}: ${m.subject ?? ""} — ${(m.body_preview ?? "").slice(0, 500)}`
              )
              .join("\n")
          );
        }
      }
      const transcript = sections.join("\n").trim().slice(-24_000);
      if (!transcript || !hasCustomerContent) continue;

      const indexRows = await store.listEntities(BUSINESS_ID);
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
        userText: composeConversationExtractionInput(transcript, entityIndex),
        temperature: 0,
        maxOutputTokens: 2000,
        responseMimeType: "application/json"
      });
      const extraction = parseGraphExtraction(text, 1);
      conversationWindows += 1;
      if (extraction.entities.length === 0) continue;
      const source = dominantConversationSource({ voiceTurns, smsTurns, emails });
      const result = await applyGraphExtraction(
        BUSINESS_ID,
        extraction,
        [transcript],
        {
          listEntities: store.listEntities,
          insertEntity: store.insertEntity as never,
          updateEntity: store.updateEntity,
          listFacts: store.listFacts,
          insertFact: store.insertFact as never,
          supersedeFacts: store.supersedeFacts,
          touchFact: store.touchFact
        },
        { source, trust: 1, attributedTo: contact.customer_e164 }
      );
      console.log(
        `[build-sources] ${contact.customer_e164} (${contact.display_name ?? "unnamed"}) ` +
          `source=${source} → +${result.entitiesCreated} entities, +${result.factsInserted} facts`
      );
    }
  }

  const built = store.counts();
  console.log(`[build] local graph: ${JSON.stringify(built)}`);

  // ---- Phase 2: REPLAY -------------------------------------------------
  const { data: transcripts } = await db
    .from("voice_call_transcripts")
    .select("id, caller_e164")
    .eq("business_id", BUSINESS_ID)
    .order("created_at", { ascending: false })
    .limit(50);
  const transcriptCaller = new Map<string, string | null>(
    (transcripts ?? []).map((t: { id: string; caller_e164: string | null }) => [t.id, t.caller_e164])
  );

  type ReplayRow = {
    question: string;
    callerE164: string | null;
    memory: { chars: number; selected: number; fromArchive: number; fallback: boolean };
    graph: { chars: number; matchedEntities: number; facts: number };
    memoryContext: string;
    graphContext: string;
  };
  const replays: ReplayRow[] = [];

  if (transcriptCaller.size > 0) {
    const { data: turns } = await db
      .from("voice_call_transcript_turns")
      .select("transcript_id, content")
      .in("transcript_id", [...transcriptCaller.keys()])
      .eq("role", "caller")
      .order("id", { ascending: false })
      .limit(400);
    const questions = (turns ?? [])
      .map((t: { transcript_id: string; content: string }) => ({
        transcriptId: t.transcript_id,
        text: String(t.content ?? "").trim()
      }))
      .filter((t) => t.text.includes("?") && t.text.split(/\s+/).length >= 4)
      .slice(0, MAX_QUESTIONS);

    for (const q of questions) {
      const callerE164 = transcriptCaller.get(q.transcriptId) ?? null;
      const memory = selectMemoryForQuestion(memoryMd, archiveMd, q.text);
      const graph = await retrieveGraphContext(BUSINESS_ID, q.text, {
        ...(callerE164 ? { callerE164 } : {}),
        listEntities: store.listEntities,
        listFacts: store.listActiveFactsForBusiness
      });
      replays.push({
        question: q.text,
        callerE164,
        memory: {
          chars: memory.context.length,
          selected: memory.selected,
          fromArchive: memory.fromArchive,
          fallback: memory.fallback
        },
        graph: {
          chars: graph.context.length,
          matchedEntities: graph.matchedEntities,
          facts: graph.facts
        },
        memoryContext: memory.context,
        graphContext: graph.context
      });
    }
  }

  // ---- Report ----------------------------------------------------------
  const summary = {
    businessId: BUSINESS_ID,
    ranAt: new Date().toISOString(),
    build: {
      memoryBullets: bullets.length,
      chatTurnsReplayed,
      conversationSources: [...SOURCES],
      conversationWindows,
      ...built
    },
    replay: {
      questions: replays.length,
      graphHit: replays.filter((r) => r.graph.chars > 0).length,
      memoryFallbacks: replays.filter((r) => r.memory.fallback).length,
      avgMemoryChars: Math.round(
        replays.reduce((s, r) => s + r.memory.chars, 0) / Math.max(replays.length, 1)
      ),
      avgGraphChars: Math.round(
        replays.reduce((s, r) => s + r.graph.chars, 0) / Math.max(replays.length, 1)
      )
    },
    replays
  };

  const outDir = path.resolve(process.cwd(), "test-results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `kg-backtest-${BUSINESS_ID.slice(0, 8)}-${Date.now()}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log("\n===== kg-backtest summary =====");
  console.log(JSON.stringify(summary.build, null, 2));
  console.log(JSON.stringify(summary.replay, null, 2));
  for (const r of replays) {
    console.log(
      `Q: ${r.question.slice(0, 90)}\n` +
        `   memory: ${r.memory.chars}ch selected=${r.memory.selected} fallback=${r.memory.fallback} | ` +
        `graph: ${r.graph.chars}ch entities=${r.graph.matchedEntities} facts=${r.graph.facts}`
    );
  }
  console.log(`\nFull report: ${outPath}`);
}

main().catch((err) => {
  console.error("[kg-backtest] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
