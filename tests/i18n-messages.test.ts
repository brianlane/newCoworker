import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import { customerLanguageLine } from "../shared/i18n/customer-language-line.ts";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe("message key parity", () => {
  it("en.json and es.json have identical keys", () => {
    expect(flattenKeys(es)).toEqual(flattenKeys(en));
  });
});

describe("customerLanguageLine", () => {
  it("returns empty when Spanish is not supported", () => {
    expect(customerLanguageLine({ supported: ["en"] })).toBe("");
  });

  it("includes default language when bilingual", () => {
    expect(customerLanguageLine({ defaultLang: "en", supported: ["en", "es"] })).toMatch(
      /Default to en/
    );
  });
});
