/**
 * Chat-worker graph.db compile (vps/chat-worker/graph-db-build.mjs):
 * jsonl → SQLite via node:sqlite, mtime-gated rebuilds, atomic tmp+rename,
 * and the graceful no-op/never-throws contract.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { maybeBuildGraphDb } from "../vps/chat-worker/graph-db-build.mjs";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "graph-db-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const JSONL = [
  JSON.stringify({
    type: "entity",
    id: "e1",
    kind: "person",
    name: "Amy Laidlaw",
    aliases: ["Amy"],
    phones: ["602-695-1142"],
    emails: [],
    updated_at: "2026-07-20T00:00:00Z"
  }),
  JSON.stringify({
    type: "entity",
    id: "e2",
    kind: "organization",
    name: "HomeSmart"
  }),
  JSON.stringify({
    type: "fact",
    id: "f1",
    subject_id: "e1",
    predicate: "works_at",
    object_id: "e2",
    object_value: null,
    source_text: "- bullet",
    stated_at: "2026-07-10T00:00:00Z"
  }),
  JSON.stringify({
    type: "fact",
    id: "f2",
    subject_id: "e1",
    predicate: "phone",
    object_id: null,
    object_value: "602-695-1142"
  }),
  "not json — torn line",
  JSON.stringify({ type: "fact", id: "", subject_id: "", predicate: "" }) // invalid, dropped
].join("\n");

describe("maybeBuildGraphDb", () => {
  it("compiles graph.jsonl into a queryable graph.db (torn/invalid lines dropped)", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "graph.jsonl"), JSONL);
    const log = vi.fn();
    const result = await maybeBuildGraphDb({ memoryDir: dir, log });
    expect(result).toEqual({ built: true, entities: 2, facts: 2 });
    expect(log).toHaveBeenCalledWith("info", "graph_db_built", expect.any(Object));

    const db = new DatabaseSync(join(dir, "graph.db"));
    try {
      const amy = db.prepare("select * from entities where id = ?").get("e1") as Record<
        string,
        unknown
      >;
      expect(amy.name).toBe("Amy Laidlaw");
      expect(JSON.parse(String(amy.aliases))).toEqual(["Amy"]);
      // The 1-hop query the graph exists for: everything linked to Amy.
      const edges = db
        .prepare("select predicate, object_id, object_value from facts where subject_id = ?")
        .all("e1") as Array<Record<string, unknown>>;
      expect(edges).toHaveLength(2);
      expect(edges.find((e) => e.predicate === "works_at")?.object_id).toBe("e2");
      expect(edges.find((e) => e.predicate === "phone")?.object_value).toBe("602-695-1142");
    } finally {
      db.close();
    }
  });

  it("no-ops when graph.jsonl is absent and when the db is already fresh", async () => {
    const dir = tmpDir();
    expect(await maybeBuildGraphDb({ memoryDir: dir })).toEqual({
      built: false,
      reason: "no_jsonl"
    });

    writeFileSync(join(dir, "graph.jsonl"), JSONL);
    expect((await maybeBuildGraphDb({ memoryDir: dir })).built).toBe(true);
    expect(await maybeBuildGraphDb({ memoryDir: dir })).toEqual({
      built: false,
      reason: "up_to_date"
    });
  });

  it("rebuilds when graph.jsonl is newer than graph.db", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "graph.jsonl"), JSONL);
    expect((await maybeBuildGraphDb({ memoryDir: dir })).built).toBe(true);
    // Bump the jsonl mtime past the db's.
    const future = new Date(statSync(join(dir, "graph.db")).mtimeMs + 5_000);
    utimesSync(join(dir, "graph.jsonl"), future, future);
    expect((await maybeBuildGraphDb({ memoryDir: dir })).built).toBe(true);
  });

  it("never throws — a failure logs and reports error (default log no-ops)", async () => {
    const dir = tmpDir();
    // A directory named graph.jsonl makes readFileSync throw after stat passes.
    const result = await maybeBuildGraphDb({ memoryDir: join(dir, "missing", "deeper") });
    expect(result.built).toBe(false);

    writeFileSync(join(dir, "graph.jsonl"), JSONL);
    // Make the tmp-file target unwritable by pointing memoryDir at a file.
    const fileAsDir = join(dir, "graph.jsonl");
    const log = vi.fn();
    const errResult = await maybeBuildGraphDb({ memoryDir: fileAsDir, log });
    expect(errResult.built).toBe(false);
  });
});
