import { describe, expect, it } from "vitest";

import {
  clientsCsv,
  filterClientRows,
  sortClientRows,
  EMPTY_CLIENTS_FILTERS,
  PAYMENT_NONE,
  type AdminClientRow
} from "@/lib/admin/clients-table";

function row(overrides: Partial<AdminClientRow> = {}): AdminClientRow {
  return {
    id: "b1",
    name: "Acme Plumbing",
    ownerEmail: "owner@acme.com",
    tier: "standard",
    createdAt: "2026-07-01T00:00:00Z",
    status: "online",
    isPaused: false,
    subscriptionStatus: "active",
    ownerQuiet: false,
    ...overrides
  };
}

describe("filterClientRows", () => {
  const rows = [
    row({ id: "a", name: "Acme Plumbing", ownerEmail: "owner@acme.com", tier: "standard" }),
    row({
      id: "b",
      name: "Bravo Salon",
      ownerEmail: "hello@bravo.io",
      tier: "starter",
      status: "offline",
      subscriptionStatus: null
    }),
    row({
      id: "c",
      name: "Charlie Corp",
      ownerEmail: "ceo@charlie.biz",
      tier: "enterprise",
      subscriptionStatus: "past_due"
    })
  ];

  it("returns everything for the empty filter set", () => {
    expect(filterClientRows(rows, EMPTY_CLIENTS_FILTERS)).toEqual(rows);
  });

  it("matches search against name and owner email, case-insensitively", () => {
    expect(filterClientRows(rows, { ...EMPTY_CLIENTS_FILTERS, search: "ACME" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterClientRows(rows, { ...EMPTY_CLIENTS_FILTERS, search: "bravo.io" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterClientRows(rows, { ...EMPTY_CLIENTS_FILTERS, search: "nomatch" })).toEqual([]);
  });

  it("filters by tier and VPS status", () => {
    expect(filterClientRows(rows, { ...EMPTY_CLIENTS_FILTERS, tier: "starter" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterClientRows(rows, { ...EMPTY_CLIENTS_FILTERS, status: "offline" }).map((r) => r.id)).toEqual(["b"]);
  });

  it("filters by payment status including the no-subscription sentinel", () => {
    expect(
      filterClientRows(rows, { ...EMPTY_CLIENTS_FILTERS, payment: "past_due" }).map((r) => r.id)
    ).toEqual(["c"]);
    expect(
      filterClientRows(rows, { ...EMPTY_CLIENTS_FILTERS, payment: PAYMENT_NONE }).map((r) => r.id)
    ).toEqual(["b"]);
  });

  it("combines search + filters (all must pass)", () => {
    expect(
      filterClientRows(rows, { search: "o", tier: "standard", status: "online", payment: "active" }).map(
        (r) => r.id
      )
    ).toEqual(["a"]);
    expect(
      filterClientRows(rows, { search: "acme", tier: "starter", status: null, payment: null })
    ).toEqual([]);
  });
});

describe("sortClientRows", () => {
  const rows = [
    row({ id: "a", name: "bravo", createdAt: "2026-07-02T00:00:00Z", tier: "starter", subscriptionStatus: null, status: "online" }),
    row({ id: "b", name: "Alpha", createdAt: "2026-07-03T00:00:00Z", tier: "standard", subscriptionStatus: "active", status: "offline" }),
    row({ id: "c", name: "Alpha", createdAt: "not-a-date", tier: "enterprise", subscriptionStatus: "pending", status: "high_load" })
  ];

  it("sorts by name (case-insensitive) both directions, stable for ties", () => {
    expect(sortClientRows(rows, "name", "asc").map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(sortClientRows(rows, "name", "desc").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts by created date, treating unparseable dates as epoch", () => {
    expect(sortClientRows(rows, "created", "asc").map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(sortClientRows(rows, "created", "desc").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by tier, payment (null last on desc), and status", () => {
    expect(sortClientRows(rows, "tier", "asc").map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(sortClientRows(rows, "payment", "desc").map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(sortClientRows(rows, "status", "asc").map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate the input", () => {
    const input = [...rows];
    sortClientRows(rows, "name", "asc");
    expect(rows).toEqual(input);
  });
});

describe("clientsCsv", () => {
  it("serializes header + rows with the payment sentinel and quoting", () => {
    const csv = clientsCsv([
      row({ name: 'Quote "Co", Inc', subscriptionStatus: null, isPaused: true, ownerQuiet: true })
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("name,owner_email,tier,payment,status,paused,churn_risk,created_at,id");
    expect(lines[1]).toBe(
      '"Quote ""Co"", Inc",owner@acme.com,standard,none,online,true,true,2026-07-01T00:00:00Z,b1'
    );
  });

  it("produces only the header for zero rows", () => {
    expect(clientsCsv([])).toBe("name,owner_email,tier,payment,status,paused,churn_risk,created_at,id");
  });
});
