/**
 * Minimal RFC-4180 CSV parse/serialize used by the import/export surface.
 *
 * Deliberately dependency-free: the files we exchange are small (import is
 * capped at MAX_IMPORT_ROWS rows / MAX_IMPORT_BYTES bytes upstream) and the
 * dialect is fixed — comma separator, `"` quoting with `""` escapes, and
 * tolerant of both \n and \r\n line endings plus a UTF-8 BOM. Headers are
 * normalized (trim, lowercase, spaces→underscores) so a hand-edited sheet
 * with "First Name" still maps onto `first_name`-style keys.
 */

export type CsvParseResult =
  | { ok: true; headers: string[]; rows: Record<string, string>[] }
  | { ok: false; error: string };

/** Normalize a header cell into a stable snake-ish key. */
export function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Parse CSV text into header-keyed row objects. Returns an error (never
 * throws) for structurally broken input: an unterminated quoted field or a
 * data row with more cells than the header. Short rows are padded with ""
 * so a trailing-comma-less export from other tools still round-trips.
 */
export function parseCsv(text: string): CsvParseResult {
  // Strip UTF-8 BOM and normalize line endings before scanning.
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) {
    return { ok: false, error: "Unterminated quoted field — check for a missing closing quote." };
  }
  // Flush the final record unless the file ended with a newline and nothing after.
  if (field.length > 0 || record.length > 0) pushRecord();

  // Drop records that are entirely empty (blank trailing lines).
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) {
    return { ok: false, error: "The file is empty." };
  }
  const headers = nonEmpty[0].map(normalizeHeader);
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const cells = nonEmpty[r];
    if (cells.length > headers.length) {
      return {
        ok: false,
        error: `Row ${r + 1} has ${cells.length} cells but the header has ${headers.length}.`
      };
    }
    const row: Record<string, string> = {};
    headers.forEach((h, c) => {
      row[h] = (cells[c] ?? "").trim();
    });
    rows.push(row);
  }
  return { ok: true, headers, rows };
}

/** Quote a cell iff it contains a comma, quote, or newline (RFC 4180). */
function serializeCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize rows (arrays of cells, header first) to CSV text with \r\n endings. */
export function serializeCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows
    .map((row) => row.map((c) => serializeCell(c === null || c === undefined ? "" : String(c))).join(","))
    .join("\r\n");
}
