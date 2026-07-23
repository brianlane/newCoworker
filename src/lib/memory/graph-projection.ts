/**
 * On-box projection of the memory knowledge graph — the local-first story.
 *
 * The graph's source of truth is central Postgres (memory_entities /
 * memory_facts), but every tenant's box gets a human-inspectable copy under
 * `/opt/rowboat/memory/`:
 *
 *   People/…, Organizations/…, Topics/…  — one Obsidian-style markdown note
 *     per entity, following upstream Rowboat's apps/x conventions
 *     (frontmatter, `## Key facts`, `[[wikilinks]]` as edges). This turns
 *     the folders deploy-client.sh has always seeded — previously read by
 *     nothing — into the real thing.
 *   graph.jsonl — the machine-readable dump the chat-worker compiles into
 *     a queryable SQLite database (graph.db) via node:sqlite.
 *
 * Everything here is pure rendering; sync-vault ships the files over SSH
 * as a tar bundle (src/lib/tar/pack.ts).
 */

import type { MemoryEntityRow, MemoryFactRow } from "./graph-db";

/** Folder per entity kind, mirroring upstream's knowledge/ layout. */
export function entityFolder(kind: string): "People" | "Organizations" | "Topics" {
  if (kind === "person") return "People";
  if (kind === "organization") return "Organizations";
  return "Topics";
}

/**
 * Safe note filename from a canonical name: strips path separators and
 * control/reserved characters, collapses whitespace, and caps the UTF-8
 * BYTE length (tar ustar headers allow 100 bytes for the whole path, and
 * the folder prefix + collision suffix need room too). Never empty — a
 * name that sanitizes away entirely falls back to the entity id.
 */
export function noteFileName(name: string, fallback: string): string {
  let cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  while (Buffer.byteLength(cleaned, "utf8") > 60) cleaned = cleaned.slice(0, -1);
  cleaned = cleaned.trim();
  return `${cleaned.length > 0 ? cleaned : fallback}.md`;
}

function factLine(fact: MemoryFactRow, byId: Map<string, MemoryEntityRow>): string {
  const stated = fact.stated_at.slice(0, 10);
  if (fact.object_entity_id) {
    const object = byId.get(fact.object_entity_id);
    const target = object ? `[[${object.canonical_name}]]` : fact.object_entity_id;
    return `- ${fact.predicate} ${target} *(stated ${stated})*`;
  }
  return `- ${fact.predicate}: ${fact.object_value ?? ""} *(stated ${stated})*`;
}

/**
 * Render one entity's note. Facts where the entity is the SUBJECT land
 * under "Key facts"; facts pointing AT it (entity as object) land under
 * "Mentioned by" so both ends of an edge are discoverable.
 */
export function renderEntityNote(
  entity: MemoryEntityRow,
  facts: MemoryFactRow[],
  byId: Map<string, MemoryEntityRow>
): string {
  const lines: string[] = [
    "---",
    `kind: ${entity.kind}`,
    ...(entity.aliases.length > 0 ? [`aliases: ${JSON.stringify(entity.aliases)}`] : []),
    ...(entity.phones.length > 0 ? [`phones: ${JSON.stringify(entity.phones)}`] : []),
    ...(entity.emails.length > 0 ? [`emails: ${JSON.stringify(entity.emails)}`] : []),
    `updated: ${entity.updated_at.slice(0, 10)}`,
    "---",
    "",
    `# ${entity.canonical_name}`
  ];

  const asSubject = facts.filter((f) => f.subject_entity_id === entity.id);
  if (asSubject.length > 0) {
    lines.push("", "## Key facts", "");
    for (const fact of asSubject) lines.push(factLine(fact, byId));
  }

  const asObject = facts.filter((f) => f.object_entity_id === entity.id);
  if (asObject.length > 0) {
    lines.push("", "## Mentioned by", "");
    for (const fact of asObject) {
      const subject = byId.get(fact.subject_entity_id);
      /* c8 ignore next -- FK integrity guarantees the subject exists */
      if (!subject) continue;
      lines.push(`- [[${subject.canonical_name}]] ${fact.predicate} this`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** One JSONL line per entity and per active fact — the graph.db source. */
export function buildGraphJsonl(entities: MemoryEntityRow[], facts: MemoryFactRow[]): string {
  const lines: string[] = [];
  for (const e of entities) {
    lines.push(
      JSON.stringify({
        type: "entity",
        id: e.id,
        kind: e.kind,
        name: e.canonical_name,
        aliases: e.aliases,
        phones: e.phones,
        emails: e.emails,
        updated_at: e.updated_at
      })
    );
  }
  for (const f of facts) {
    lines.push(
      JSON.stringify({
        type: "fact",
        id: f.id,
        subject_id: f.subject_entity_id,
        predicate: f.predicate,
        object_id: f.object_entity_id,
        object_value: f.object_value,
        source_text: f.source_text,
        stated_at: f.stated_at
      })
    );
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export type ProjectionFile = { path: string; content: string };

/**
 * The full projection: one note per entity plus graph.jsonl. Note-name
 * collisions (two distinct entities sanitizing to the same filename) are
 * disambiguated with a short id suffix so neither note is lost.
 */
export function buildGraphProjectionFiles(
  entities: MemoryEntityRow[],
  facts: MemoryFactRow[]
): ProjectionFile[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const files: ProjectionFile[] = [];
  const taken = new Set<string>();
  for (const entity of entities) {
    const folder = entityFolder(entity.kind);
    let name = noteFileName(entity.canonical_name, entity.id);
    if (taken.has(`${folder}/${name}`)) {
      name = name.replace(/\.md$/, ` (${entity.id.slice(0, 8)}).md`);
    }
    taken.add(`${folder}/${name}`);
    files.push({
      path: `${folder}/${name}`,
      content: renderEntityNote(entity, facts, byId)
    });
  }
  const jsonl = buildGraphJsonl(entities, facts);
  if (jsonl) files.push({ path: "graph.jsonl", content: jsonl });
  return files;
}
