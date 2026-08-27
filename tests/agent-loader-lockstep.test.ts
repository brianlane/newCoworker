import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cursor holds the agent-instruction bodies (.cursor/rules, .cursor/skills,
 * .cursor/memory). Claude Code must load those same files via @ imports and
 * skill-directory symlinks, never a second copy. /init, /import, a generated
 * CLAUDE.md, an .agents/ tree, or `ln -s AGENTS.md CLAUDE.md` each produce a
 * second copy. This test makes those artifacts uncommittable.
 */

const ROOT = join(__dirname, "..");
const RULES_DIR = join(ROOT, ".cursor/rules");
const CURSOR_SKILLS = join(ROOT, ".cursor/skills");
const CLAUDE_SKILLS = join(ROOT, ".claude/skills");
const CLAUDE_MD = join(ROOT, "CLAUDE.md");
const AGENTS_MD = join(ROOT, "AGENTS.md");
const NESTED_CLAUDE_MD = join(ROOT, "supabase/migrations/CLAUDE.md");
const MEMORY_MD = join(ROOT, ".cursor/memory/MEMORY.md");

const ROOT_IMPORT_RE =
  /^@\.cursor\/rules\/[A-Za-z0-9._-]+\.mdc$|^@\.cursor\/memory\/MEMORY\.md$/;
const NESTED_IMPORT_RE =
  /^@\.\.\/\.\.\/\.cursor\/rules\/[A-Za-z0-9._-]+\.mdc$/;
const AGENTS_LINE_CAP = 40;

const GENERATOR_NAME_RE =
  /generate-claude-md|sync-claude-md|generate-agent-rules|generateAgentRules/i;
const WRITE_CLAUDE_RE =
  /\b(writeFileSync|writeFile|outputFileSync)\b[\s\S]{0,120}CLAUDE\.md/;
const WRITE_RULES_RE =
  /\b(writeFileSync|writeFile|outputFileSync)\b[\s\S]{0,120}\.cursor\/rules/;
const SYMLINK_AGENTS_RE = /ln\s+-s[^\n]*AGENTS\.md[^\n]*CLAUDE\.md/;

type RuleFile = {
  name: string;
  alwaysApply: boolean;
  globs: string | null;
  body: string;
  heading: string | null;
};

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function importLines(text: string): string[] {
  return stripHtmlComments(text)
    .split("\n")
    .map((ln) => ln.trim())
    .filter((ln) => ln.length > 0);
}

function parseRule(name: string): RuleFile {
  const text = readFileSync(join(RULES_DIR, name), "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const fields: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1]] = kv[2].trim();
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const heading = body.match(/^# .+$/m)?.[0] ?? null;
  return {
    name,
    alwaysApply: fields.alwaysApply === "true",
    globs: fields.globs ?? null,
    body,
    heading
  };
}

function listRules(): RuleFile[] {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".mdc"))
    .sort()
    .map(parseRule);
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      out.push(...walkFiles(p));
      continue;
    }
    if (ent.isFile()) out.push(p);
  }
  return out;
}

describe("agent loader lockstep", () => {
  const rules = listRules();
  const alwaysOn = rules.filter((r) => r.alwaysApply);
  const migrationGlobbed = rules.filter(
    (r) => r.globs === "supabase/migrations/**"
  );

  it("root CLAUDE.md is a regular file, not a symlink to AGENTS.md", () => {
    expect(lstatSync(CLAUDE_MD).isSymbolicLink()).toBe(false);
    expect(lstatSync(AGENTS_MD).isSymbolicLink()).toBe(false);
    expect(realpathSync(CLAUDE_MD)).not.toBe(realpathSync(AGENTS_MD));
    expect(statSync(CLAUDE_MD).ino).not.toBe(statSync(AGENTS_MD).ino);
  });

  it("root CLAUDE.md is only @ imports of always-on rules plus MEMORY.md", () => {
    const lines = importLines(readFileSync(CLAUDE_MD, "utf8"));
    expect(lines.length).toBeGreaterThan(0);
    for (const ln of lines) {
      expect(ln, `not an allowed import: ${ln}`).toMatch(ROOT_IMPORT_RE);
    }
    const expected = [
      ...alwaysOn.map((r) => `@.cursor/rules/${r.name}`),
      "@.cursor/memory/MEMORY.md"
    ].sort();
    expect([...lines].sort()).toEqual(expected);
    expect(existsSync(MEMORY_MD)).toBe(true);
  });

  it("nested migrations CLAUDE.md is only @ imports of the globbed migration rules", () => {
    const lines = importLines(readFileSync(NESTED_CLAUDE_MD, "utf8"));
    expect(migrationGlobbed.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    for (const ln of lines) {
      expect(ln, `not an allowed nested import: ${ln}`).toMatch(
        NESTED_IMPORT_RE
      );
    }
    const expected = migrationGlobbed
      .map((r) => `@../../.cursor/rules/${r.name}`)
      .sort();
    expect([...lines].sort()).toEqual(expected);
  });

  it("AGENTS.md stays an index, not a second copy of the rules", () => {
    const text = readFileSync(AGENTS_MD, "utf8");
    const lineCount = text.split("\n").length;
    expect(
      lineCount,
      `AGENTS.md is ${lineCount} lines; keep it as a short index (cap ${AGENTS_LINE_CAP})`
    ).toBeLessThanOrEqual(AGENTS_LINE_CAP);
    for (const rule of rules) {
      if (!rule.heading) continue;
      expect(
        text.includes(rule.heading),
        `AGENTS.md contains rule heading ${rule.heading}`
      ).toBe(false);
    }
  });

  it("rule bodies do not appear in CLAUDE.md, AGENTS.md, or regular .claude files", () => {
    const claudeMd = readFileSync(CLAUDE_MD, "utf8");
    const agentsMd = readFileSync(AGENTS_MD, "utf8");
    const nested = readFileSync(NESTED_CLAUDE_MD, "utf8");
    const claudeFiles = walkFiles(join(ROOT, ".claude")).map((p) => ({
      rel: relative(ROOT, p),
      text: readFileSync(p, "utf8")
    }));
    const haystacks: { rel: string; text: string }[] = [
      { rel: "CLAUDE.md", text: claudeMd },
      { rel: "AGENTS.md", text: agentsMd },
      { rel: "supabase/migrations/CLAUDE.md", text: nested },
      ...claudeFiles
    ];
    const offenders: string[] = [];
    for (const rule of rules) {
      const needle = rule.body.trim();
      if (needle.length < 80) continue;
      for (const hay of haystacks) {
        if (hay.text.includes(needle)) {
          offenders.push(`${rule.name} body found in ${hay.rel}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every Cursor skill is a relative symlink under .claude/skills", () => {
    const cursorSkills = readdirSync(CURSOR_SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(cursorSkills.length).toBeGreaterThan(0);
    const claudeEntries = existsSync(CLAUDE_SKILLS)
      ? readdirSync(CLAUDE_SKILLS).filter((n) => n !== ".DS_Store").sort()
      : [];
    expect(claudeEntries).toEqual(cursorSkills);
    for (const name of cursorSkills) {
      const claudePath = join(CLAUDE_SKILLS, name);
      expect(
        lstatSync(claudePath).isSymbolicLink(),
        `.claude/skills/${name} must be a symlink`
      ).toBe(true);
      expect(realpathSync(claudePath)).toBe(
        realpathSync(join(CURSOR_SKILLS, name))
      );
    }
  });

  it("does not grow an .agents/ tree or a CLAUDE.md generator", () => {
    expect(existsSync(join(ROOT, ".agents"))).toBe(false);
    const scanRoots = [join(ROOT, "scripts"), join(ROOT, "debug")];
    const offenders: string[] = [];
    for (const dir of scanRoots) {
      for (const abs of walkFiles(dir)) {
        if (!/\.(ts|js|mjs|cjs|sh)$/.test(abs)) continue;
        const rel = relative(ROOT, abs);
        const text = readFileSync(abs, "utf8");
        if (GENERATOR_NAME_RE.test(rel) || GENERATOR_NAME_RE.test(text)) {
          offenders.push(`${rel}: generator name`);
        }
        if (WRITE_CLAUDE_RE.test(text)) {
          offenders.push(`${rel}: writes CLAUDE.md`);
        }
        if (WRITE_RULES_RE.test(text)) {
          offenders.push(`${rel}: writes .cursor/rules`);
        }
        if (SYMLINK_AGENTS_RE.test(text)) {
          offenders.push(`${rel}: symlinks AGENTS.md to CLAUDE.md`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("session start warns on a fat CLAUDE.md and pins Claude auto-memory", () => {
    const hook = readFileSync(join(ROOT, "scripts/sync-context-pack.sh"), "utf8");
    expect(hook).toContain("CLAUDE.md is not import-only");
    expect(hook).toContain("autoMemoryDirectory");
    expect(hook).toContain("CLAUDE_PROJECT_DIR");
    expect(hook).toContain(".cursor/memory");
  });
});
