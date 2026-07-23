/**
 * Hand-written declarations for graph-db-build.mjs so the TypeScript test
 * suite (tests/chat-worker-graph-db-build.test.ts) can import it typed —
 * same pattern as memory-capture.d.mts / email-tool.d.mts.
 */

export const DEFAULT_MEMORY_DIR: string;

export type GraphDbBuildResult =
  | { built: true; entities: number; facts: number }
  | { built: false; reason: "no_jsonl" | "up_to_date" | "sqlite_unavailable" | "error" };

export function maybeBuildGraphDb(options?: {
  memoryDir?: string;
  log?: (level: string, msg: string, fields?: Record<string, unknown>) => void;
}): Promise<GraphDbBuildResult>;
