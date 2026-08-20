import { describe, expect, it } from "vitest";

import {
  CONTACTS_EXPORT_HEADERS,
  selectedContactsCsv,
  type SelectedContactExportRow
} from "../src/lib/csv/contacts-export-shape";
import { parseCsv } from "../src/lib/csv/csv";

/**
 * Coverage for src/lib/csv/contacts-export-shape.ts: the client-side
 * "export selected" builder shares the server export's column contract, so
 * the two files open side by side and a selected export re-imports cleanly.
 */

function row(overrides: Partial<SelectedContactExportRow> = {}): SelectedContactExportRow {
  return {
    e164: "+15550001111",
    label: "+15550001111",
    name: "Jane Doe",
    type: "customer",
    tags: ["VIP", "New Lead"],
    lastChannel: "sms",
    lastInteractionAt: "2026-08-01T12:00:00Z",
    totalInteractions: 4,
    createdAt: "2026-07-01T12:00:00Z",
    ...overrides
  };
}

describe("selectedContactsCsv", () => {
  it("writes the shared export header row", () => {
    const parsed = parseCsv(selectedContactsCsv([row()]));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.headers).toEqual([...CONTACTS_EXPORT_HEADERS]);
  });

  it("maps a row into the export columns, blanking what the list view lacks", () => {
    const parsed = parseCsv(selectedContactsCsv([row()]));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rows).toEqual([
      {
        phone: "+15550001111",
        name: "Jane Doe",
        type: "customer",
        email: "",
        sms_reply_mode: "",
        pinned_notes: "",
        tags: "VIP, New Lead",
        aliases: "",
        last_channel: "sms",
        last_interaction_at: "2026-08-01T12:00:00Z",
        total_interactions: "4",
        created_at: "2026-07-01T12:00:00Z"
      }
    ]);
  });

  it("blanks the name cell when the list fell back to showing the key itself", () => {
    const parsed = parseCsv(
      selectedContactsCsv([
        row({ name: "+15550001111", lastChannel: null, lastInteractionAt: null })
      ])
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rows[0].name).toBe("");
    expect(parsed.rows[0].last_channel).toBe("");
    expect(parsed.rows[0].last_interaction_at).toBe("");
  });

  it("keeps the email-keyed shape the full export uses (key in phone, bare address as label)", () => {
    const parsed = parseCsv(
      selectedContactsCsv([
        row({ e164: "email:sam@example.com", label: "sam@example.com", name: "Sam Okoye" })
      ])
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rows[0].phone).toBe("email:sam@example.com");
    expect(parsed.rows[0].name).toBe("Sam Okoye");
  });

  it("quotes cells that carry commas so names round-trip", () => {
    const parsed = parseCsv(selectedContactsCsv([row({ name: "Doe, Jane", tags: [] })]));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rows[0].name).toBe("Doe, Jane");
    expect(parsed.rows[0].tags).toBe("");
  });
});
