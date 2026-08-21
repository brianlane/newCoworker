import { describe, expect, it } from "vitest";

import {
  FUB_HEADER_PATTERNS,
  FUB_STAGE_TO_LIFECYCLE_TAG,
  fubStageTag,
  hasIdentityColumn,
  mapFubCsvRow,
  matchFubHeaders,
  splitTagCell,
  type FubHeaderMap
} from "@/lib/fub-import/map";
import { normalizeHeader } from "@/lib/csv/csv";

/** Headers the way parseCsv hands them over (lowercased, spaces to _). */
function headers(...raw: string[]): string[] {
  return raw.map(normalizeHeader);
}

function mapOf(...raw: string[]): FubHeaderMap {
  return matchFubHeaders(headers(...raw)).map;
}

describe("fubStageTag", () => {
  it("maps every documented FUB default stage onto a lifecycle tag", () => {
    // The map is the contract; asserting the table itself would restate it,
    // so this walks every key through the function callers actually use.
    for (const [stage, tag] of Object.entries(FUB_STAGE_TO_LIFECYCLE_TAG)) {
      expect(fubStageTag(stage)).toBe(tag);
    }
  });

  it("is case and whitespace insensitive", () => {
    expect(fubStageTag("  Hot Prospect ")).toBe("Engaged");
    expect(fubStageTag("LEAD")).toBe("New Lead");
  });

  it("keeps an unmapped custom stage as a fub: tag rather than dropping it", () => {
    expect(fubStageTag("Past Client")).toBe("fub:past client");
  });

  it("clamps a very long custom stage to the tag length cap", () => {
    const tag = fubStageTag("x".repeat(200));
    expect(tag).toHaveLength(40);
    expect(tag?.startsWith("fub:xxx")).toBe(true);
  });

  it("returns null for blank, null and undefined", () => {
    expect(fubStageTag("   ")).toBeNull();
    expect(fubStageTag(null)).toBeNull();
    expect(fubStageTag(undefined)).toBeNull();
  });
});

describe("matchFubHeaders", () => {
  it("matches the plain export headers", () => {
    const { map } = matchFubHeaders(
      headers("First Name", "Last Name", "Email", "Phone", "Stage", "Source", "Tags")
    );
    expect(map.firstName).toEqual(["first_name"]);
    expect(map.lastName).toEqual(["last_name"]);
    expect(map.email).toEqual(["email"]);
    expect(map.phone).toEqual(["phone"]);
    expect(map.stage).toEqual(["stage"]);
    expect(map.source).toEqual(["source"]);
    expect(map.tags).toEqual(["tags"]);
  });

  it("collects every numbered phone and email column in file order", () => {
    const map = mapOf("Phone 1", "Phone 2", "Email 1", "Email 2", "Mobile Phone");
    expect(map.phone).toEqual(["phone_1", "phone_2", "mobile_phone"]);
    expect(map.email).toEqual(["email_1", "email_2"]);
  });

  it("accepts the label variants an export or a hand-edited sheet uses", () => {
    expect(mapOf("Full Name").name).toEqual(["full_name"]);
    expect(mapOf("Contact Name").name).toEqual(["contact_name"]);
    expect(mapOf("Lead Source").source).toEqual(["lead_source"]);
    expect(mapOf("Lead Stage").stage).toEqual(["lead_stage"]);
    expect(mapOf("Email Address").email).toEqual(["email_address"]);
    expect(mapOf("Cell").phone).toEqual(["cell"]);
    expect(mapOf("Tag").tags).toEqual(["tag"]);
    expect(mapOf("First").firstName).toEqual(["first"]);
  });

  it("keeps the FIRST column for a single-value field, so a later one cannot shadow it", () => {
    const map = mapOf("Name", "Contact Name");
    expect(map.name).toEqual(["name"]);
  });

  it("reports every column nothing claimed, so a dropped column is visible", () => {
    const { unmatched } = matchFubHeaders(
      headers("Phone", "Background", "Birthday", "Assigned Agent")
    );
    expect(unmatched).toEqual(["background", "birthday", "assigned_agent"]);
  });

  it("claims a header for exactly one field", () => {
    // "name" also matches nothing else, but first_name must not be eaten by
    // the `name` pattern before firstName sees it.
    const map = mapOf("First Name");
    expect(map.firstName).toEqual(["first_name"]);
    expect(map.name).toEqual([]);
  });

  it("has a pattern for every field it declares", () => {
    const map = mapOf();
    expect(Object.keys(map).sort()).toEqual(Object.keys(FUB_HEADER_PATTERNS).sort());
  });
});

describe("hasIdentityColumn", () => {
  it("is true when either a phone or an email column exists", () => {
    expect(hasIdentityColumn(mapOf("Phone"))).toBe(true);
    expect(hasIdentityColumn(mapOf("Email"))).toBe(true);
  });

  it("is false for a file with names but nothing to key a person by", () => {
    expect(hasIdentityColumn(mapOf("First Name", "Last Name", "Stage"))).toBe(false);
  });
});

describe("splitTagCell", () => {
  it("splits on comma, semicolon and pipe, trimming and dropping blanks", () => {
    expect(splitTagCell("buyer, seller ;; vip|  ")).toEqual(["buyer", "seller", "vip"]);
  });

  it("returns nothing for an empty cell", () => {
    expect(splitTagCell("   ")).toEqual([]);
  });
});

describe("mapFubCsvRow", () => {
  const map = mapOf(
    "First Name",
    "Last Name",
    "Phone 1",
    "Phone 2",
    "Email 1",
    "Stage",
    "Source",
    "Tags"
  );

  it("keys on the first usable phone and keeps the address on email", () => {
    const out = mapFubCsvRow(
      {
        first_name: "Jane",
        last_name: "Doe",
        phone_1: "not a number",
        phone_2: "(602) 555-1234",
        email_1: "jane@example.com",
        stage: "Lead",
        source: "Zillow",
        tags: "buyer, vip"
      },
      map,
      2
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.key).toBe("+16025551234");
    expect(out.value.email).toBe("jane@example.com");
    expect(out.value.name).toBe("Jane Doe");
    expect(out.value.leadSource).toBe("Zillow");
    expect(out.value.tags).toContain("New Lead");
    expect(out.value.tags).toContain("buyer");
    expect(out.value.tags).toContain("vip");
  });

  it("falls back to the email key when no phone cell holds a number", () => {
    const out = mapFubCsvRow({ email_1: "sam@example.com", first_name: "Sam" }, map, 3);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.key).toBe("email:sam@example.com");
    expect(out.value.email).toBe("sam@example.com");
  });

  it("reports the file row when a person has no usable identity at all", () => {
    const out = mapFubCsvRow({ first_name: "Ghost", phone_1: "n/a", email_1: "nope" }, map, 7);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("row 7");
    expect(out.reason).toContain("no usable phone number or email address");
  });

  it("prefers a full name column over first plus last", () => {
    const withFull = mapOf("Name", "First Name", "Last Name", "Phone");
    const out = mapFubCsvRow(
      { name: "Dr. Jane Doe", first_name: "Jane", last_name: "Doe", phone: "+16025551234" },
      withFull,
      2
    );
    expect(out.ok && out.value.name).toBe("Dr. Jane Doe");
  });

  it("falls back to first plus last when the full name cell is blank", () => {
    const withFull = mapOf("Name", "First Name", "Last Name", "Phone");
    const out = mapFubCsvRow(
      { name: "   ", first_name: "Jane", last_name: "Doe", phone: "+16025551234" },
      withFull,
      2
    );
    expect(out.ok && out.value.name).toBe("Jane Doe");
  });

  it("leaves name, leadSource and tags empty when the file has no such columns", () => {
    const bare = mapOf("Phone");
    const out = mapFubCsvRow({ phone: "+16025551234" }, bare, 2);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.name).toBeNull();
    expect(out.value.leadSource).toBeNull();
    expect(out.value.tags).toEqual([]);
    expect(out.value.email).toBeNull();
  });

  it("tolerates a row missing a cell the header row promised", () => {
    // parseCsv fills every header key on every row, so this only happens to a
    // direct caller; the guard exists so one does not read `undefined.trim()`.
    // The header row promises a name column here and the row omits it, which
    // is the case the full-name read has to survive.
    const withFull = mapOf("Name", "Phone 1", "Source", "Tags");
    const out = mapFubCsvRow({ phone_1: "+16025551234" }, withFull, 2);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.name).toBeNull();
    expect(out.value.leadSource).toBeNull();
    expect(out.value.tags).toEqual([]);
  });

  it("clamps a very long lead source to the column's limit", () => {
    const out = mapFubCsvRow({ phone_1: "+16025551234", source: "x".repeat(500) }, map, 2);
    expect(out.ok && out.value.leadSource).toHaveLength(120);
  });

  it("keeps an unmapped stage as its fub: tag alongside the file's own tags", () => {
    const out = mapFubCsvRow(
      { phone_1: "+16025551234", stage: "Past Client", tags: "sphere" },
      map,
      2
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tags).toContain("fub:past client");
    expect(out.value.tags).toContain("sphere");
  });
});
