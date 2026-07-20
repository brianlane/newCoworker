/**
 * src/lib/db/contact-form-sink.ts — the platform contact-form sink
 * designation behind the admin "Contact form (platform)" card.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createSupabaseServiceClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient
}));

import {
  getContactFormSinkBusinessId,
  setContactFormSink
} from "@/lib/db/contact-form-sink";

const BIZ = "11111111-1111-4111-8111-111111111111";

type ReadRow = { data: unknown; error: { message: string } | null };
type WriteError = { message: string } | null;

function makeDb(
  read: ReadRow,
  opts: { clearError?: WriteError; setError?: WriteError } = {}
) {
  const maybeSingle = vi.fn().mockResolvedValue(read);
  const updateCalls: Array<Record<string, unknown>> = [];
  const eqArgs: Array<[string, unknown]> = [];
  const neqArgs: Array<[string, unknown]> = [];
  // The clear pass chains `.eq("contact_form_sink", true).neq("id", …)`; the
  // designation write awaits `.eq("id", …)` directly — so `.eq()` returns a
  // REAL promise (resolving the designation result) that also carries `.neq`
  // (resolving the clear result). Real promises keep v8 coverage's async
  // block accounting honest, unlike a synchronous custom thenable.
  const update = vi.fn((patch: Record<string, unknown>) => {
    updateCalls.push(patch);
    return {
      eq: vi.fn((col: string, val: unknown) => {
        eqArgs.push([col, val]);
        return Object.assign(Promise.resolve({ error: opts.setError ?? null }), {
          neq: vi.fn((ncol: string, nval: unknown) => {
            neqArgs.push([ncol, nval]);
            return Promise.resolve({ error: opts.clearError ?? null });
          })
        });
      })
    };
  });
  const db = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle }))
      })),
      update
    }))
  };
  return { db: db as never, update, updateCalls, eqArgs, neqArgs };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getContactFormSinkBusinessId", () => {
  it("returns the designated business id", async () => {
    const { db } = makeDb({ data: { id: BIZ }, error: null });
    expect(await getContactFormSinkBusinessId(db)).toBe(BIZ);
  });

  it("returns null when no business is designated", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await getContactFormSinkBusinessId(db)).toBeNull();
  });

  it("throws on a read error", async () => {
    const { db } = makeDb({ data: null, error: { message: "boom" } });
    await expect(getContactFormSinkBusinessId(db)).rejects.toThrow(
      "getContactFormSinkBusinessId: boom"
    );
  });

  it("creates a service client when none is provided", async () => {
    const { db } = makeDb({ data: { id: BIZ }, error: null });
    createSupabaseServiceClient.mockResolvedValue(db);
    expect(await getContactFormSinkBusinessId()).toBe(BIZ);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("setContactFormSink", () => {
  it("enable clears any OTHER sink first, then designates the target", async () => {
    const { db, updateCalls, eqArgs, neqArgs } = makeDb({ data: null, error: null });
    await setContactFormSink(BIZ, true, db);
    expect(updateCalls).toEqual([
      { contact_form_sink: false },
      { contact_form_sink: true }
    ]);
    expect(eqArgs).toEqual([
      ["contact_form_sink", true],
      ["id", BIZ]
    ]);
    expect(neqArgs).toEqual([["id", BIZ]]);
  });

  it("disable only updates the target (no clear pass)", async () => {
    const { db, updateCalls, neqArgs } = makeDb({ data: null, error: null });
    await setContactFormSink(BIZ, false, db);
    expect(updateCalls).toEqual([{ contact_form_sink: false }]);
    expect(neqArgs).toEqual([]);
  });

  it("throws when the clear pass fails", async () => {
    const { db } = makeDb({ data: null, error: null }, { clearError: { message: "locked" } });
    await expect(setContactFormSink(BIZ, true, db)).rejects.toThrow(
      "setContactFormSink clear: locked"
    );
  });

  it("throws when the designation write fails", async () => {
    const { db } = makeDb({ data: null, error: null }, { setError: { message: "denied" } });
    await expect(setContactFormSink(BIZ, true, db)).rejects.toThrow(
      "setContactFormSink: denied"
    );
  });

  it("creates a service client when none is provided (both toggle directions)", async () => {
    const { db } = makeDb({ data: null, error: null });
    createSupabaseServiceClient.mockResolvedValue(db);
    await setContactFormSink(BIZ, false);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);

    const { db: db2, updateCalls } = makeDb({ data: null, error: null });
    createSupabaseServiceClient.mockResolvedValue(db2);
    await setContactFormSink(BIZ, true);
    expect(updateCalls).toEqual([
      { contact_form_sink: false },
      { contact_form_sink: true }
    ]);
  });
});
