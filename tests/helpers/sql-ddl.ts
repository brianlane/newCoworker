/**
 * Shared SQL text handling for the tests that read `supabase/migrations/**`
 * as evidence.
 *
 * Two guards parse the migration corpus rather than trusting a hand-kept
 * list: `privacy-coverage.test.ts` (does any privacy module still touch a
 * name the schema no longer resolves?) and
 * `residency-box-schema-columns.test.ts` (does the tenant box carry every
 * column central added to a moved table?). Both need the same thing first:
 * SQL with its comments removed and its string literals intact.
 */

/**
 * Blank out SQL comments so DDL prose cannot register a phantom statement,
 * WITHOUT touching string literals.
 *
 * The literal-awareness is not academic. 20260711002041_spend_velocity_alerts
 * carries a comment string ending in a slash-star at :38 (an /api/admin route
 * glob) and an every-ten-minutes cron literal at :161 that begins with a
 * star-slash. A naive block-comment regex reads the first as an opening
 * delimiter and the second as its close, silently eating the 120 lines between
 * them, two CREATE TABLEs included. That failure is why this scanner tracks
 * single-quoted strings and dollar-quoted bodies and only recognises a comment
 * outside them.
 *
 * Comments are replaced with spaces rather than removed, so every surviving
 * statement keeps its original offset and the in-file ordering the callers
 * rely on stays exact.
 */
export function stripSqlComments(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    const dollar = /^\$[a-z_]*\$/i.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      continue;
    }
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      const stop = nl === -1 ? sql.length : nl;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") {
          depth++;
          j += 2;
        } else if (sql.slice(j, j + 2) === "*/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Split the top level of a parenthesised DDL body on commas, keeping nested
 * parens (a type's precision, a CHECK's expression, an ARRAY literal) intact.
 */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * The body of the parenthesised list that starts at `open` (the index of the
 * opening paren), or null when it is never closed.
 */
export function balancedBody(sql: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}
