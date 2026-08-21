#!/usr/bin/env tsx
/**
 * Context pack generator: the deterministic replacement for the session
 * bootstrap ritual.
 *
 * Nearly every agent session on this repo used to open the same way: read the
 * 1,700-line README, skim the application code, re-read two weeks of chat
 * transcripts, re-skim two weeks of pull requests. That is the same cognition
 * bought again on every session, at token prices, to arrive at the same
 * orientation. This script produces that orientation once, mechanically, and
 * writes it to `docs/CONTEXT-PACK.md` for the agent to read instead.
 *
 * Everything here is READ-ONLY: git metadata, the README's own headings, the
 * `gh` CLI, the local agent transcripts, and (optionally) a few Supabase
 * SELECTs. It writes exactly one file. Every source degrades to a visible
 * "unavailable" note rather than failing the run, so a laptop with no `gh`
 * auth or no `.env` still gets a useful pack.
 *
 * Usage:
 *   npx tsx scripts/context-pack.ts             # regenerate docs/CONTEXT-PACK.md everywhere
 *   npx tsx scripts/context-pack.ts --days 30   # widen the PR/chat window
 *   npx tsx scripts/context-pack.ts --out -     # print to stdout instead
 *   npx tsx scripts/context-pack.ts --no-fleet  # skip the Supabase queries
 *
 * A relative --out (the default included) is written into EVERY checkout of
 * the repo: the main one and each linked worktree. Claude Code opens every
 * session in a fresh worktree under .claude/worktrees/, and a gitignored file
 * is never part of a fresh checkout, so a single-copy pack was unreadable in
 * exactly the place sessions begin. The SessionStart hook
 * (scripts/sync-context-pack.sh) covers worktrees created after the last
 * regeneration. An absolute --out, or "-", stays a single target.
 *
 * Env:
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY
 *     read from the repo-root `.env` for the fleet snapshot; without them
 *     that one section is skipped.
 *   CONTEXT_PACK_TRANSCRIPTS_DIR
 *     overrides where the agent transcripts are found. Unset, the Claude Code
 *     archives (`~/.claude/projects/<slug>/`, one per checkout a session has
 *     run in, worktrees included) and the older Cursor one
 *     (`~/.cursor/projects/<slug>/agent-transcripts/`) are read.
 *
 * The output is gitignored on purpose. It is derived from local transcripts
 * and live tenant rows, both of which stay on the laptop, and a committed copy
 * would be stale within hours anyway.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* -------------------------------------------------------------------------- */
/* args                                                                        */
/* -------------------------------------------------------------------------- */

export type ContextPackArgs = {
  /** Lookback window for the PR and chat digests. */
  days: number;
  /** Output path relative to the repo root, or "-" for stdout. */
  out: string;
  /** Skip the Supabase fleet snapshot. */
  fleet: boolean;
};

export function parseContextPackArgs(argv: string[]): ContextPackArgs {
  const out: ContextPackArgs = { days: 14, out: "docs/CONTEXT-PACK.md", fleet: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--days") out.days = Number(argv[++i] ?? "14") || 14;
    else if (a === "--out") out.out = argv[++i] ?? out.out;
    else if (a === "--no-fleet") out.fleet = false;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: npx tsx scripts/context-pack.ts [--days 14] [--out docs/CONTEXT-PACK.md|-] [--no-fleet]\n"
      );
      process.exit(0);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Run a command and return stdout, or null if it fails for any reason. */
function tryExec(file: string, args: string[], opts: { cwd?: string; maxBuffer?: number } = {}): string | null {
  try {
    return execFileSync(file, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}

/**
 * Every checkout that shares this repo's history, nearest first. A worktree is
 * a second entry: `.env` and the Cursor transcript archive both live only in
 * the main checkout, so a pack generated from a worktree has to look there.
 */
function checkoutRoots(repoRoot: string): string[] {
  const roots = [repoRoot];
  const commonDir = tryExec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot });
  if (commonDir) {
    const main = path.dirname(commonDir.trim());
    if (main !== repoRoot) roots.push(main);
  }
  return roots;
}

/** Worktree paths out of `git worktree list --porcelain`, main checkout first. */
export function parseWorktreePaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    const m = /^worktree (.+)$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Every checkout of this repo: the main one plus each linked worktree. This
 * is the mirror set for a relative output path. Claude Code opens each
 * session in a fresh worktree, so a pack that exists only where the generator
 * last ran is invisible in exactly the place sessions begin.
 */
function allCheckouts(repoRoot: string): string[] {
  const roots = checkoutRoots(repoRoot);
  const porcelain = tryExec("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  for (const p of porcelain ? parseWorktreePaths(porcelain) : []) {
    if (!roots.includes(p)) roots.push(p);
  }
  return roots;
}

/**
 * Load `.env` without clobbering the real environment, mirroring
 * `debug/_shared.ts` (kept separate so this script has no debug/ dependency).
 */
function loadEnv(repoRoot: string): void {
  const envPath = checkoutRoots(repoRoot)
    .map((root) => path.join(root, ".env"))
    .find((p) => fs.existsSync(p));
  if (!envPath) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, k, vRaw] = m;
    if (process.env[k] === undefined) process.env[k] = vRaw.replace(/^["']|["']$/g, "");
  }
}

/**
 * Blunt redaction of end-user identifiers. The transcript digest quotes what
 * was typed into chat, which regularly includes a lead's phone or email, and
 * `debug/README.md` is explicit that those must not spread into new files.
 * Business DIDs get the same treatment; they are recoverable from the fleet
 * snapshot when actually needed.
 */
export function redactIdentifiers(text: string): string {
  return (
    text
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
      // E.164 and conventionally punctuated numbers only. A bare run of digits
      // is deliberately left alone: this repo talks constantly about migration
      // stamps (20260726…) and VM ids, and redacting those made the digest
      // unreadable while protecting nothing.
      .replace(/\+\d{10,15}\b/g, "<phone>")
      .replace(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "<phone>")
  );
}

/** Collapse whitespace and cut to a single readable line. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Escape a value for a markdown table cell.
 *
 * The backslash must be escaped BEFORE the pipe: escaping only `|` leaves a
 * trailing backslash in the input able to consume the escape we just added
 * (`a\` becomes `a\|`, whose backslash escapes our backslash and frees the
 * pipe to split the cell). CodeQL flags the pipe-only form for exactly this.
 */
export function escapeTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** GitHub's heading-to-anchor slug, for linking into the README. */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/* -------------------------------------------------------------------------- */
/* section: repo map                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A hand-written map of where things live. This is the one section that is
 * curated rather than derived: a directory listing tells an agent the names of
 * the folders, which it can already see, and not what any of them are for.
 */
const REPO_MAP: ReadonlyArray<{ path: string; what: string }> = [
  { path: "src/app", what: "Next.js routes: marketing site, /dashboard (owner), /admin (us), /api" },
  { path: "src/lib", what: "All business logic. Vitest coverage is scoped here, so behavior belongs here, not in routes" },
  { path: "src/lib/ai-flows", what: "AiFlow engine: steps, triggers, goals, booking precheck, team routing" },
  { path: "src/lib/memory", what: "Markdown memory + the knowledge graph (write path, retrieval, source registry)" },
  { path: "supabase/migrations", what: "Schema. Stamp new files with scripts/new-migration.sh, never by hand" },
  { path: "supabase/functions", what: "Edge functions: SMS/voice webhooks and the cron sweeps" },
  { path: "vps/chat-worker", what: "Per-tenant box worker (job queue, memory capture, graph.db build)" },
  { path: "vps/voice-bridge", what: "Telnyx media <-> Gemini Live bridge, per tenant box" },
  { path: "vps/llm-router", what: "Sidecar routing gemini-* to Google and everything else to Ollama" },
  { path: "debug", what: "Read-mostly ops CLIs against the LIVE fleet. Has its own README and security rules" },
  { path: "scripts/oneshot", what: "Ledger-recorded one-time fixes (applied_oneshots). Idempotent, dry-run by default" },
  { path: "tests", what: "Unit + CI guard tests (tool parity, KG source coverage, no-em-dashes, lockstep pins)" },
  { path: "docs", what: "Runbooks and incident writeups referenced from the README" },
  { path: "docs/tenants", what: "Per-tenant dossiers: read one instead of re-deriving a tenant from chat history" },
  { path: "PRDs", what: "Product requirement docs and white-glove build plans" }
];

function renderRepoMap(repoRoot: string): string {
  const lines = ["| Path | What lives there |", "| --- | --- |"];
  for (const entry of REPO_MAP) {
    if (!fs.existsSync(path.join(repoRoot, entry.path))) continue;
    lines.push(`| \`${entry.path}\` | ${entry.what} |`);
  }
  const counts: string[] = [];
  for (const dir of ["debug", "scripts/oneshot"]) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    const n = fs.readdirSync(abs).filter((f) => f.endsWith(".ts")).length;
    counts.push(`${n} scripts in \`${dir}\``);
  }
  if (counts.length > 0) lines.push("", `Tool inventory: ${counts.join(", ")}.`);
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* section: README index                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Index the README's own `##` headings with line numbers. The README is the
 * source of truth and too long to read whole; this turns "read the README"
 * into "jump to the three sections this task needs".
 */
export function extractReadmeSections(readme: string): Array<{ title: string; line: number }> {
  const out: Array<{ title: string; line: number }> = [];
  const lines = readme.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^## (.+)$/.exec(line);
    if (m) out.push({ title: m[1].trim(), line: i + 1 });
  }
  return out;
}

function renderReadmeIndex(repoRoot: string): string {
  const readmePath = path.join(repoRoot, "README.md");
  if (!fs.existsSync(readmePath)) return "_README.md not found._";
  const sections = extractReadmeSections(fs.readFileSync(readmePath, "utf8"));
  if (sections.length === 0) return "_No `##` sections found in README.md._";
  const lines = sections.map((s) => `- [${s.title}](../README.md#${headingAnchor(s.title)}) (line ${s.line})`);
  return [
    `${sections.length} sections. Open the one the task needs instead of reading the file end to end.`,
    "",
    ...lines
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* section: pull requests                                                      */
/* -------------------------------------------------------------------------- */

type PrRow = { number: number; title: string; state: string; mergedAt: string | null; createdAt: string };

export function isoDaysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function renderPullRequests(repoRoot: string, days: number): string {
  const since = isoDaysAgo(days);
  const raw = tryExec(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "400",
      "--json",
      "number,title,state,mergedAt,createdAt",
      "--search",
      `created:>=${since} sort:created-desc`
    ],
    { cwd: repoRoot }
  );
  if (raw === null) return "_`gh` unavailable or not authenticated. Run `gh auth login` and regenerate._";

  let rows: PrRow[];
  try {
    rows = JSON.parse(raw) as PrRow[];
  } catch {
    return "_`gh` returned output this script could not parse._";
  }
  if (rows.length === 0) return `_No pull requests created since ${since}._`;

  const merged = rows.filter((r) => r.state === "MERGED").length;
  const open = rows.filter((r) => r.state === "OPEN").length;
  const lines = [
    `${rows.length} PRs created since ${since}: ${merged} merged, ${open} open, ${rows.length - merged - open} closed unmerged.`,
    "",
    "| PR | State | Title |",
    "| --- | --- | --- |"
  ];
  for (const r of rows) {
    lines.push(`| #${r.number} | ${r.state.toLowerCase()} | ${escapeTableCell(oneLine(r.title, 140))} |`);
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* section: chat digest                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How the transcript archives key a workspace path: path separators AND dots
 * both flatten to dashes, so `/a/b/.claude/x` becomes `-a-b--claude-x`.
 * Claude Code keeps the leading dash, Cursor drops it; callers strip it for
 * the Cursor side.
 */
export function archiveSlug(absPath: string): string {
  return absPath.replace(/[/.]/g, "-");
}

/**
 * Whether an archive directory name belongs to a worktree of the checkout
 * whose flattened slug is `flat`. Worktree slugs extend the checkout slug,
 * but a bare prefix test would also pull in sibling projects that happen to
 * share the name (`newCoworker-backup`), so only the repo's two worktree
 * conventions match: the app's `.claude/worktrees/<name>` (whose dot makes
 * the flattened `--claude-worktrees-` infix unambiguous) and the manual
 * `<repo>-wt-<name>` siblings. Matched against archive names rather than
 * live worktrees because transcripts outlive their worktree: the app removes
 * a worktree once its session is done, and that removed worktree's archive
 * is often exactly the history worth keeping in the digest.
 */
export function isWorktreeArchiveOf(name: string, flat: string): boolean {
  return name.startsWith(`${flat}--claude-worktrees-`) || name.startsWith(`${flat}-wt-`);
}

/** Directory entries of `dir`, or nothing when it does not exist. */
function tryReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Find every agent-transcript archive for this repo.
 *
 * Two harnesses have written history here: Cursor, under
 * `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, and Claude
 * Code, under `~/.claude/projects/<slug>/<id>.jsonl`. Both are searched, so
 * the digest keeps showing sessions from before the switch rather than going
 * blank the day the tool changed. Newest-first ordering across the merged set
 * is by mtime, so which archive a session came from does not matter downstream.
 *
 * The slug is the session's working directory, flattened. Cursor always ran
 * sessions in the main checkout, so one slug was the whole archive; Claude
 * Code runs each session in its own worktree, so one repo owns many archive
 * directories: the main checkout's, plus one per worktree, current or since
 * removed. Worktree slugs extend the checkout slug, so a prefix scan over the
 * archive root finds them all, deleted worktrees included.
 */
export function resolveTranscriptDirs(repoRoot: string): string[] {
  const override = process.env.CONTEXT_PACK_TRANSCRIPTS_DIR;
  if (override) return fs.existsSync(override) ? [override] : [];

  const claudeRoot = path.join(os.homedir(), ".claude", "projects");
  const cursorRoot = path.join(os.homedir(), ".cursor", "projects");
  const found: string[] = [];
  const add = (dir: string): void => {
    if (fs.existsSync(dir) && !found.includes(dir)) found.push(dir);
  };
  for (const candidate of checkoutRoots(repoRoot)) {
    const flat = archiveSlug(candidate);
    const cursorFlat = flat.replace(/^-+/, "");
    add(path.join(claudeRoot, flat));
    add(path.join(cursorRoot, cursorFlat, "agent-transcripts"));
    for (const name of tryReaddir(claudeRoot)) {
      if (isWorktreeArchiveOf(name, flat)) add(path.join(claudeRoot, name));
    }
    for (const name of tryReaddir(cursorRoot)) {
      if (isWorktreeArchiveOf(name, cursorFlat)) add(path.join(cursorRoot, name, "agent-transcripts"));
    }
  }
  return found;
}

/**
 * Session files in an archive, covering both on-disk layouts: Claude Code
 * writes `<id>.jsonl` flat in the project directory, Cursor nests it as
 * `<id>/<id>.jsonl`. Detecting by layout rather than by archive path means the
 * `CONTEXT_PACK_TRANSCRIPTS_DIR` override works for either without a flag.
 */
export function sessionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = path.join(dir, entry.name, `${entry.name}.jsonl`);
      if (fs.existsSync(nested)) found.push(nested);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/**
 * A line from either archive. Cursor tags the speaker at the top level as
 * `role`; Claude Code uses `type` and repeats it under `message.role`, mixes
 * in non-message bookkeeping lines (permission modes, file snapshots), sends
 * plain-string content for typed user turns, and flags subagent turns with
 * `isSidechain`.
 */
type TranscriptTurn = {
  role?: string;
  type?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
};

/** Speaker of a turn, or "" for a bookkeeping line that has no speaker. */
export function turnRole(turn: TranscriptTurn | null): string {
  if (!turn || turn.isSidechain) return "";
  const role = turn.role ?? turn.message?.role ?? turn.type ?? "";
  return role === "user" || role === "assistant" ? role : "";
}

/**
 * Prose of a turn. Tool calls and tool results carry no `text` part and so
 * come back empty, which is what lets the callers below skip them by testing
 * for content rather than by enumerating every non-prose line type.
 */
export function turnText(turn: TranscriptTurn | null): string {
  const content = turn?.message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join(" ");
}

/** Pull the user's actual question out of the harness-wrapped first message. */
export function extractUserQuery(text: string): string {
  const tagged = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
  const body = tagged ? tagged[1] : text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ");
  return oneLine(body, Number.MAX_SAFE_INTEGER);
}

/**
 * Drop the ritual preamble from a batch of opening asks.
 *
 * Sessions here overwhelmingly begin with the same incantation ("read the
 * readme and review the application code, then review the past conversations
 * and skim the github pull requests…") before getting to the real question.
 * Truncating an ask to a readable length would therefore show the ritual and
 * hide the ask, so any leading sentence that recurs across a meaningful share
 * of sessions is removed first. Frequency-based rather than a hardcoded
 * phrase, so it keeps working when the incantation drifts.
 *
 * The last sentence is never stripped: an ask that is nothing but boilerplate
 * should still show something.
 */
export function stripRitualPrefixes(asks: string[], threshold = 0.2): string[] {
  const sentencesOf = (s: string): string[] => s.split(/(?<=[.!?])\s+/).filter((x) => x.trim().length > 0);
  const normalize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  const perAsk = asks.map(sentencesOf);
  const counts = new Map<string, number>();
  for (const sentences of perAsk) {
    const seen = new Set<string>();
    for (const sentence of sentences) {
      const key = normalize(sentence);
      if (key.length < 15 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const minOccurrences = Math.max(3, Math.ceil(asks.length * threshold));

  return perAsk.map((sentences) => {
    let i = 0;
    while (i < sentences.length - 1 && (counts.get(normalize(sentences[i])) ?? 0) >= minOccurrences) i += 1;
    return sentences.slice(i).join(" ").trim();
  });
}

type ChatSession = { at: Date; id: string; ask: string; outcome: string; prs: number[] };

/**
 * PR numbers a session touched, read from full GitHub URLs only. The bare
 * `#123` form appears in too many other contexts (issues, quoted CI output) to
 * be trustworthy, whereas a pull URL is unambiguous. This is what joins the
 * chat digest to the PR digest: "which session produced #931".
 *
 * Deliberately "touched", not "shipped": a session that reviewed a tenant's
 * history cites plenty of PRs it did not write, and the URL alone cannot tell
 * the two apart.
 */
export function extractPrNumbers(transcript: string): number[] {
  const found = new Set<number>();
  const re = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript)) !== null) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/**
 * Session tails are frequently the agent explaining a stale background-shell
 * notification rather than summarizing the work, which makes a naive "last
 * assistant message" a poor outcome line. Skip those and keep walking back.
 */
const TAIL_NOISE = /^(that|those|both|it)('s| is| are| was| were)? ?(just )?(a )?stale|^that was the `?npm|background|notification/i;

function readSession(file: string): ChatSession | null {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const parse = (line: string): TranscriptTurn | null => {
    try {
      return JSON.parse(line) as TranscriptTurn;
    } catch {
      return null;
    }
  };
  // Walk forwards for the opening ask rather than trusting line 0. A Claude
  // Code transcript opens with bookkeeping lines (permission mode, file
  // snapshot) before any turn, and both archives interleave tool-result turns
  // that are tagged "user" but carry no prose. Anything that reduces to
  // nothing after the harness wrappers are stripped is one of those.
  let ask = "";
  for (const line of lines) {
    const turn = parse(line);
    if (turnRole(turn) !== "user") continue;
    ask = extractUserQuery(turnText(turn));
    if (ask) break;
  }
  if (!ask) return null;

  // Walk backwards for the last assistant message carrying real prose: the
  // final turns are often bare tool calls with no text at all, or the agent
  // dismissing a stale background-shell notification.
  let outcome = "";
  let fallback = "";
  for (let i = lines.length - 1; i >= 0 && !outcome; i -= 1) {
    const turn = parse(lines[i]);
    if (turnRole(turn) !== "assistant") continue;
    const text = turnText(turn).trim();
    if (text.length <= 80) continue;
    if (TAIL_NOISE.test(text)) {
      if (!fallback) fallback = text;
      continue;
    }
    outcome = text;
  }

  return {
    at: fs.statSync(file).mtime,
    id: path.basename(file, ".jsonl"),
    // Full ask: the ritual preamble is stripped across the whole batch before
    // anything is truncated, otherwise the truncation would keep the preamble
    // and discard the question.
    ask: redactIdentifiers(ask),
    outcome: redactIdentifiers(outcome || fallback || "(no closing summary in transcript)"),
    prs: extractPrNumbers(content)
  };
}

function renderChatDigest(repoRoot: string, days: number): string {
  const dirs = resolveTranscriptDirs(repoRoot);
  if (dirs.length === 0) return "_No agent transcripts found for this workspace._";

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const sessions: ChatSession[] = [];
  for (const dir of dirs) {
    for (const file of sessionFiles(dir)) {
      if (fs.statSync(file).mtimeMs < cutoff) continue;
      const session = readSession(file);
      if (session) sessions.push(session);
    }
  }
  if (sessions.length === 0) return `_No agent sessions in the last ${days} days._`;

  sessions.sort((a, b) => b.at.getTime() - a.at.getTime());
  const asks = stripRitualPrefixes(sessions.map((s) => s.ask));
  const lines = [
    `${sessions.length} sessions in the last ${days} days, newest first. Shared opening boilerplate is stripped. Cite one as [title](<full id>) when referring back to it.`,
    ""
  ];
  sessions.forEach((s, i) => {
    const head = s.prs.slice(0, 6).map((n) => `#${n}`).join(", ");
    const more = s.prs.length > 6 ? ` +${s.prs.length - 6}` : "";
    const shipped = s.prs.length > 0 ? ` [PRs: ${head}${more}]` : "";
    lines.push(`- **${s.at.toISOString().slice(0, 16).replace("T", " ")}** \`${s.id.slice(0, 8)}\` ${oneLine(asks[i], 170)}`);
    lines.push(`  - ${oneLine(s.outcome, 150)}${shipped}`);
  });
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* section: fleet snapshot                                                     */
/* -------------------------------------------------------------------------- */

type BusinessRow = {
  id: string;
  name: string;
  tier: string;
  status: string;
  created_at: string;
  /** Null on a row written before the column existed; reads as the default. */
  data_residency_mode: string | null;
};

async function renderFleet(repoRoot: string): Promise<string> {
  try {
    return await renderFleetInner(repoRoot);
  } catch (err) {
    // A missing dependency or an unreachable database must not cost the caller
    // the other four sections, which need nothing but the filesystem.
    return `_Fleet snapshot unavailable: ${err instanceof Error ? err.message : String(err)}_`;
  }
}

async function renderFleetInner(repoRoot: string): Promise<string> {
  loadEnv(repoRoot);
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return "_`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` not in `.env`; fleet snapshot skipped._";

  const { createClient } = await import("@supabase/supabase-js");
  const { fetchAllPaged } = await import("../src/lib/supabase/paging.ts");
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Routes and flows are paged: PostgREST caps a response at 1000 rows, and a
  // silently short read here would print wrong DIDs and wrong flow counts,
  // which is worse than printing nothing (renderFleet's catch reports a
  // thrown error as an unavailable section).
  const [businesses, routes, flows] = await Promise.all([
    db.from("businesses").select("id,name,tier,status,created_at,data_residency_mode").order("created_at", { ascending: true }),
    fetchAllPaged<{ to_e164: string; business_id: string }>(
      (from, to) =>
        db
          .from("telnyx_voice_routes")
          .select("to_e164,business_id")
          .order("to_e164", { ascending: true })
          .range(from, to),
      { label: "telnyx_voice_routes" }
    ),
    fetchAllPaged<{ business_id: string; enabled: boolean; id: string }>(
      (from, to) => db.from("ai_flows").select("id,business_id,enabled").order("id", { ascending: true }).range(from, to),
      { label: "ai_flows" }
    )
  ]);
  if (businesses.error) return `_Fleet snapshot failed: ${businesses.error.message}_`;

  const didFor = new Map<string, string>();
  for (const r of routes.rows) {
    if (!didFor.has(r.business_id)) didFor.set(r.business_id, r.to_e164);
  }
  const flowCount = new Map<string, { total: number; enabled: number }>();
  for (const f of flows.rows) {
    const cur = flowCount.get(f.business_id) ?? { total: 0, enabled: 0 };
    cur.total += 1;
    if (f.enabled) cur.enabled += 1;
    flowCount.set(f.business_id, cur);
  }

  const rows = (businesses.data ?? []) as BusinessRow[];
  const lines = [
    `${rows.length} tenants. Ids are printed in full because that is what every \`debug/\` script takes as an argument, and because the reviewer sandboxes share their first 8 characters.`,
    "",
    "| Business | Business id | Tier | Status | Residency | DID | Flows (on/total) |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const b of rows) {
    const counts = flowCount.get(b.id) ?? { total: 0, enabled: 0 };
    lines.push(
      `| ${escapeTableCell(b.name.trim())} | \`${b.id}\` | ${b.tier} | ${b.status} | ${b.data_residency_mode ?? "supabase"} | ${didFor.get(b.id) ?? "-"} | ${counts.enabled}/${counts.total} |`
    );
  }
  if (routes.truncated || flows.truncated) {
    lines.push("", "**Partial:** the route/flow read hit its row ceiling, so DIDs and flow counts may be incomplete.");
  }
  lines.push("", "Per-tenant detail lives in `docs/tenants/`.");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

function repoRootFromHere(): string {
  const top = tryExec("git", ["rev-parse", "--show-toplevel"]);
  return top ? top.trim() : process.cwd();
}

export async function buildContextPack(repoRoot: string, args: ContextPackArgs): Promise<string> {
  const head = tryExec("git", ["log", "-1", "--format=%h %s"], { cwd: repoRoot })?.trim() ?? "unknown";
  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  const fleet = args.fleet ? await renderFleet(repoRoot) : "_Skipped (`--no-fleet`)._";

  return [
    "# Context pack (generated)",
    "",
    "**Do not edit by hand.** Regenerate with `npx tsx scripts/context-pack.ts`.",
    "",
    `Generated ${generatedAt} UTC-ish (local clock), at \`${head}\`, window ${args.days} days.`,
    "",
    "This file exists so an agent session does not have to re-derive the same",
    "orientation from the README, the transcript archive, and the PR list every",
    "time. Read it first, then open only the raw sources the task actually needs.",
    "",
    "## Repo map",
    "",
    renderRepoMap(repoRoot),
    "",
    "## README section index",
    "",
    renderReadmeIndex(repoRoot),
    "",
    `## Pull requests (last ${args.days} days)`,
    "",
    renderPullRequests(repoRoot, args.days),
    "",
    `## Agent sessions (last ${args.days} days)`,
    "",
    renderChatDigest(repoRoot, args.days),
    "",
    "## Fleet snapshot",
    "",
    fleet,
    ""
  ].join("\n");
}

/**
 * Write via a same-directory temp file and rename, so a session reading the
 * pack mid-regeneration sees the old copy or the new one, never a torn one.
 */
function writeAtomic(outPath: string, content: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, outPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseContextPackArgs(process.argv.slice(2));
  const repoRoot = repoRootFromHere();
  const markdown = await buildContextPack(repoRoot, args);

  if (args.out === "-") {
    process.stdout.write(markdown);
    return;
  }
  if (path.isAbsolute(args.out)) {
    writeAtomic(args.out, markdown);
    process.stdout.write(`wrote ${args.out} (${markdown.length} bytes)\n`);
    return;
  }

  // A relative target is mirrored into every checkout, so the next session
  // finds the pack no matter which worktree it opens in. A checkout that
  // cannot be written (say a worktree pruned mid-run) is reported, not fatal.
  const skipped: string[] = [];
  let written = 0;
  for (const root of allCheckouts(repoRoot)) {
    if (!fs.existsSync(root)) continue;
    try {
      writeAtomic(path.join(root, args.out), markdown);
      written += 1;
    } catch {
      skipped.push(root);
    }
  }
  for (const root of skipped) process.stderr.write(`skipped ${root}: not writable\n`);
  if (written === 0) throw new Error("could not write the pack into any checkout");
  process.stdout.write(`wrote ${args.out} (${markdown.length} bytes) in ${written} checkout(s)\n`);
}

// Only run when invoked directly, so the pure helpers above stay unit-testable.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("context-pack.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`context-pack failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
