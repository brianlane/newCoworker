import { describe, expect, it } from "vitest";
import { normalizeHeader, parseCsv, serializeCsv } from "../src/lib/csv/csv";

/**
 * Coverage for src/lib/csv/csv.ts — the dependency-free RFC-4180 dialect
 * (comma, `"` quoting with `""` escapes, \n / \r\n endings, UTF-8 BOM).
 */

describe("normalizeHeader", () => {
  it("trims, lowercases, and snake-cases spaces", () => {
    expect(normalizeHeader("  First Name ")).toBe("first_name");
    expect(normalizeHeader("PHONE")).toBe("phone");
    expect(normalizeHeader("sms  reply   mode")).toBe("sms_reply_mode");
  });
});

describe("parseCsv", () => {
  it("parses simple rows keyed by normalized headers", () => {
    const res = parseCsv("Phone,First Name\n+15550001111,Jane\n+15550002222,Joe");
    expect(res).toEqual({
      ok: true,
      headers: ["phone", "first_name"],
      rows: [
        { phone: "+15550001111", first_name: "Jane" },
        { phone: "+15550002222", first_name: "Joe" }
      ]
    });
  });

  it("handles quoted fields with commas, escaped quotes, and newlines", () => {
    const res = parseCsv('name,notes\n"Doe, Jane","She said ""hi""\nand left"');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0].name).toBe("Doe, Jane");
    expect(res.rows[0].notes).toBe('She said "hi"\nand left');
  });

  it("strips a UTF-8 BOM and tolerates \\r\\n endings and blank lines", () => {
    const res = parseCsv("\uFEFFphone,name\r\n+15550001111,Jane\r\n\r\n");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toEqual([{ phone: "+15550001111", name: "Jane" }]);
  });

  it("pads short rows with empty strings", () => {
    const res = parseCsv("phone,name,email\n+15550001111,Jane");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]).toEqual({ phone: "+15550001111", name: "Jane", email: "" });
  });

  it("errors on a row with more cells than the header", () => {
    const res = parseCsv("phone,name\n+15550001111,Jane,extra");
    expect(res).toEqual({ ok: false, error: "Row 2 has 3 cells but the header has 2." });
  });

  it("errors on an unterminated quoted field", () => {
    const res = parseCsv('phone,name\n+15550001111,"Jane');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Unterminated quoted field/);
  });

  it("errors on an entirely empty file", () => {
    expect(parseCsv("")).toEqual({ ok: false, error: "The file is empty." });
    expect(parseCsv("\n\n  \n")).toEqual({ ok: false, error: "The file is empty." });
  });

  it("parses a header-only file into zero rows", () => {
    const res = parseCsv("phone,name\n");
    expect(res).toEqual({ ok: true, headers: ["phone", "name"], rows: [] });
  });

  it("treats a quote mid-field per RFC (quote starts quoted section)", () => {
    // `a"b",c` — the quote after `a` opens a quoted run containing `b`.
    const res = parseCsv('h1,h2\na"b",c');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]).toEqual({ h1: "ab", h2: "c" });
  });
});

describe("serializeCsv", () => {
  it("joins cells with commas and rows with CRLF", () => {
    expect(serializeCsv([["a", "b"], ["1", "2"]])).toBe("a,b\r\n1,2");
  });

  it("quotes cells containing commas, quotes, or newlines", () => {
    expect(serializeCsv([['say "hi"', "x,y", "line\nbreak"]])).toBe(
      '"say ""hi""","x,y","line\nbreak"'
    );
  });

  it("renders null/undefined as empty and numbers/booleans as strings", () => {
    expect(serializeCsv([[null, undefined, 7, true]])).toBe(",,7,true");
  });

  it("round-trips through parseCsv", () => {
    const csv = serializeCsv([
      ["phone", "notes"],
      ["+15550001111", 'call "after 5", not before']
    ]);
    const res = parseCsv(csv);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]).toEqual({
      phone: "+15550001111",
      notes: 'call "after 5", not before'
    });
  });
});
