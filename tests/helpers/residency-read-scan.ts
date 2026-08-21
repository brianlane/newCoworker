/**
 * AST scan for reads of a residency-moved table.
 *
 * Backs tests/residency-read-coverage.test.ts and
 * debug/residency-read-report.ts, so the guard and the report can never
 * disagree about what is in the tree.
 *
 * WHY THE TYPESCRIPT PARSER AND NOT A REGEX: a regex over raw source gets
 * this wrong in both directions here. It misses `.from("contacts")` followed
 * by a comment before `.select(...)`, and it FALSELY matches the
 * `db.from("contacts")` written inside src/lib/contacts/lookup.ts's own
 * docblock. Stripping TS comments with another regex just moves the bug
 * (string literals containing `//`, template literals, regex literals). The
 * parser also gives two things a regex cannot: the enclosing function name,
 * which lets a registry key survive line churn, and structural matching of
 * `readMovedRows({ table: "..." })`, which is what makes "routed" mean
 * routed FOR THIS TABLE.
 *
 * That distinction is not academic. src/lib/db/email-log.ts imports the
 * routing layer and routes four of its readers, while
 * `threadsAnsweredByFlow` and `getEmailLogThreadIdentity` still read
 * `email_log` centrally. A file-level "does it import residency/read" check
 * calls that file clean. `email_log` is a PURGED table, so those two are
 * exactly the silent-incomplete reads the guard exists to find.
 *
 * Syntactic parse only (ts.createSourceFile). No ts.createProgram: it needs
 * a tsconfig, the root tsconfig EXCLUDES supabase/functions, and it costs
 * tens of seconds. This runs over the whole tree in about a second.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

import { RESIDENCY_MOVED_TABLES, type ResidencyMovedTable } from "@/lib/residency/tables";

/** Directories walked, relative to the repo root. */
export const SCAN_ROOTS = ["src", "supabase/functions"] as const;

/**
 * Skipped, with the reason. The residency layer is the routing layer: it
 * reads moved tables by construction and cannot route through itself.
 */
export const SCAN_EXCLUDED = ["src/lib/residency/"] as const;

/** PostgREST verbs. The first one in the chain decides read vs write. */
const READ_VERBS = new Set(["select"]);
const WRITE_VERBS = new Set(["insert", "update", "upsert", "delete"]);

/** Routing helpers whose `table:` argument marks a site routed. */
const ROUTING_HELPERS = new Set(["readMovedRows", "countMovedRows"]);

/** Opt-in marker for the shape where the box branch lives in a sibling helper. */
export const ROUTED_MARKER = "residency: routed";

export type ReadSite = {
  /** Repo-relative, POSIX separators. */
  file: string;
  /** Nearest enclosing named function, or "<module>" at top level. */
  fn: string;
  table: ResidencyMovedTable;
  /** Reporting only. Never part of a registry key. */
  line: number;
  routed: boolean;
};

export type DynamicSite = {
  file: string;
  fn: string;
  line: number;
  /** Source text of the non-literal argument, for the report. */
  argText: string;
  /** The PostgREST verb, so a dynamic write can be told from a dynamic read. */
  verb: string;
};

export type ScanResult = {
  sites: ReadSite[];
  dynamic: DynamicSite[];
  /** Write sites. Not gated, but a floor proves the verb classifier still splits. */
  writeSites: number;
  filesParsed: number;
};

/** Stable key for the registry: survives line churn, not renames. */
export function siteKey(s: { file: string; fn: string; table: string }): string {
  return `${s.file}::${s.fn}::${s.table}`;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function sourceFilesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    if (name.endsWith(".d.ts")) continue;
    const parentDir = toPosix(relative(root, entry.parentPath));
    const rel = `${parentDir}/${name}`;
    if (SCAN_EXCLUDED.some((ex) => rel.startsWith(ex))) continue;
    out.push(rel);
  }
  return out.sort();
}

/** Nearest enclosing named function-ish declaration. */
function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (
      (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
      n.parent &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
  }
  return "<module>";
}

/**
 * Every enclosing function, innermost first. A site inside a `.map()` arrow
 * must still see the routing helper that sits in the exported function
 * around it, so the routed check walks outward rather than stopping at the
 * nearest one.
 */
function enclosingFunctionNodes(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n)
    ) {
      out.push(n);
    }
  }
  return out;
}

/**
 * First PostgREST verb in the fluent chain hanging off this `.from(...)`.
 * `db.from(t).select(...)` parses as PropertyAccess(Call(from), "select"),
 * so walking parents finds the verbs in call order.
 */
function firstChainVerb(fromCall: ts.CallExpression): string | undefined {
  let cur: ts.Node = fromCall;
  for (let hops = 0; hops < 8; hops++) {
    const parent = cur.parent;
    if (!parent) return undefined;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === cur) {
      const name = parent.name.text;
      if (READ_VERBS.has(name) || WRITE_VERBS.has(name)) return name;
      cur = parent.parent && ts.isCallExpression(parent.parent) ? parent.parent : parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.expression === cur) {
      cur = parent;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Receivers whose `.from()` is not a Supabase table call. `Array.from` and
 * `Buffer.from` alone accounted for most of the raw `.from(` hits in this
 * repo, and `db.storage.from(bucket)` is object storage.
 */
const NON_TABLE_FROM_RECEIVERS = new Set([
  "Array",
  "Buffer",
  "Object",
  "Uint8Array",
  "Int8Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "Map",
  "Set",
  "Date",
  "String",
  "Number"
]);

function isNonTableFrom(callee: ts.PropertyAccessExpression): boolean {
  const obj = callee.expression;
  if (ts.isPropertyAccessExpression(obj) && obj.name.text === "storage") return true;
  if (ts.isIdentifier(obj) && NON_TABLE_FROM_RECEIVERS.has(obj.text)) return true;
  return false;
}

/** Unwrap `x as const` / `x as T` so a literal behind an assertion still reads as one. */
function unwrapAssertions(node: ts.Expression): ts.Expression {
  let cur: ts.Expression = node;
  while (ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isParenthesizedExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Does this function route THIS table through the residency layer?
 *
 * Two facts must both hold inside the function: it calls a routing helper,
 * and it names this table in a `table:` property. They are checked
 * separately rather than as "the helper's argument literally says
 * table: 'x'", because the real call sites hoist the shared half of the
 * request into a `base` object and spread it
 * (src/lib/db/email-log.ts:381 does exactly this, with
 * `table: "email_log" as const`). Requiring the literal to sit in the
 * helper's own argument marked that function unrouted, which is a false
 * positive that would have put a correctly-routed reader on the debt list.
 *
 * Checked per function and per table, never per file: a file that routes one
 * reader tells you nothing about the reader next to it.
 */
function functionRoutesTable(fnNode: ts.Node | undefined, table: string): boolean {
  if (!fnNode) return false;
  let callsHelper = false;
  let namesTable = false;
  const visit = (n: ts.Node): void => {
    if (callsHelper && namesTable) return;
    if (ts.isCallExpression(n)) {
      const name = ts.isPropertyAccessExpression(n.expression)
        ? n.expression.name.text
        : ts.isIdentifier(n.expression)
          ? n.expression.text
          : "";
      if (ROUTING_HELPERS.has(name)) callsHelper = true;
    }
    if (ts.isPropertyAssignment(n)) {
      const key = ts.isIdentifier(n.name)
        ? n.name.text
        : ts.isStringLiteral(n.name)
          ? n.name.text
          : "";
      if (key === "table") {
        const init = unwrapAssertions(n.initializer);
        if (ts.isStringLiteral(init) && init.text === table) namesTable = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fnNode);
  return callsHelper && namesTable;
}

/** `// residency: routed` on the statement containing the site. */
function hasRoutedMarker(sf: ts.SourceFile, node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (!ts.isStatement(n)) continue;
    const ranges = ts.getLeadingCommentRanges(sf.text, n.getFullStart()) ?? [];
    for (const r of ranges) {
      if (sf.text.slice(r.pos, r.end).includes(ROUTED_MARKER)) return true;
    }
    if (ts.isBlock(n.parent ?? n)) break;
  }
  return false;
}

export function scanResidencyReads(root: string): ScanResult {
  const movedTables = new Set<string>(RESIDENCY_MOVED_TABLES);
  const sites: ReadSite[] = [];
  const dynamic: DynamicSite[] = [];
  let writeSites = 0;
  let filesParsed = 0;

  for (const dir of SCAN_ROOTS) {
    for (const rel of sourceFilesUnder(root, dir)) {
      const text = readFileSync(join(root, rel), "utf8");
      // Cheap prefilter: a file with no `.from(` cannot contribute.
      if (!text.includes(".from(")) continue;
      const sf = ts.createSourceFile(
        rel,
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      filesParsed++;

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "from" &&
          node.arguments.length === 1 &&
          !isNonTableFrom(node.expression)
        ) {
          const arg = node.arguments[0];
          const verb = firstChainVerb(node);
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const fn = enclosingFunctionName(node);
          const literal =
            ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)
              ? arg.text
              : undefined;

          if (literal === undefined) {
            // Unknown table, so the name proves nothing and a PostgREST verb
            // is the only evidence this is a table call at all. Without one
            // it is some other `.from()` and recording it would bury the
            // handful of real dynamic reads in noise.
            if (verb) {
              dynamic.push({ file: rel, fn, line, argText: arg.getText(sf), verb });
            }
          } else if (movedTables.has(literal)) {
            if (verb && WRITE_VERBS.has(verb)) {
              writeSites++;
            } else {
              // No verb found counts as a READ: an unrecognized call shape
              // must demand a decision, not slip through as a write.
              const fnNodes = enclosingFunctionNodes(node);
              sites.push({
                file: rel,
                fn,
                table: literal as ResidencyMovedTable,
                line,
                routed:
                  fnNodes.some((f) => functionRoutesTable(f, literal)) ||
                  hasRoutedMarker(sf, node)
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  sites.sort((a, b) => siteKey(a).localeCompare(siteKey(b)) || a.line - b.line);
  dynamic.sort((a, b) => (a.file + a.fn).localeCompare(b.file + b.fn) || a.line - b.line);
  return { sites, dynamic, writeSites, filesParsed };
}
