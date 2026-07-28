/**
 * Prospecting suppression (src/lib/outreach/suppress.ts): an opt-out must land
 * on BOTH axes, because outreach and campaigns read different tables. Stamping
 * only the ledger would let a later campaign email someone who already asked
 * to be left alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

const getProspectSpy = vi.fn();
const patchProspectSpy = vi.fn(async () => true);
vi.mock("@/lib/outreach/db", () => ({
  getProspect: (...args: unknown[]) => getProspectSpy(...(args as [])),
  patchProspect: (...args: unknown[]) => patchProspectSpy(...(args as []))
}));

import { suppressContactByEmail, suppressProspect } from "@/lib/outreach/suppress";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PROSPECT = "22222222-2222-4222-8222-222222222222";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of ["update", "eq", "ilike", "is"]) c[m] = vi.fn(() => c);
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as Chain;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  patchProspectSpy.mockResolvedValue(true);
});

describe("suppressProspect", () => {
  it("retires the ledger row AND stamps the contact holding that address", async () => {
    getProspectSpy.mockResolvedValue({ id: PROSPECT, email: "Owner@Acme.com" });
    const c = chain({ error: null });
    await suppressProspect(BIZ, PROSPECT, makeDb(c));

    expect(patchProspectSpy).toHaveBeenCalledWith(
      BIZ,
      PROSPECT,
      { status: "unsubscribed", status_detail: "unsubscribed via link" },
      expect.anything()
    );
    // The contact stamp is the campaign axis: normalized address, idempotent.
    expect(c.ilike).toHaveBeenCalledWith("email", "owner@acme.com");
    expect(c.is).toHaveBeenCalledWith("marketing_unsubscribed_at", null);
  });

  it("records the reason when the opt-out arrived as a reply instead of a click", async () => {
    getProspectSpy.mockResolvedValue({ id: PROSPECT, email: null });
    await suppressProspect(BIZ, PROSPECT, makeDb(chain({ error: null })), "asked to stop by reply");
    expect(patchProspectSpy).toHaveBeenCalledWith(
      BIZ,
      PROSPECT,
      { status: "unsubscribed", status_detail: "asked to stop by reply" },
      expect.anything()
    );
  });

  it("does nothing, and says nothing, for a prospect that is not there", async () => {
    getProspectSpy.mockResolvedValue(null);
    const db = makeDb(chain({ error: null }));
    await expect(suppressProspect(BIZ, PROSPECT, db)).resolves.toBeUndefined();
    expect(patchProspectSpy).not.toHaveBeenCalled();
  });

  it("works through the default client", async () => {
    getProspectSpy.mockResolvedValue({ id: PROSPECT, email: null });
    defaultClientSpy.mockReturnValue(makeDb(chain({ error: null })));
    await suppressProspect(BIZ, PROSPECT);
    expect(patchProspectSpy).toHaveBeenCalled();
  });
});

describe("suppressContactByEmail", () => {
  it("never throws when the stamp fails: the ledger row is already retired", async () => {
    await expect(
      suppressContactByEmail(BIZ, "a@b.com", makeDb(chain({ error: { message: "down" } })))
    ).resolves.toBeUndefined();
  });

  it("works through the default client", async () => {
    defaultClientSpy.mockReturnValue(makeDb(chain({ error: null })));
    await expect(suppressContactByEmail(BIZ, "a@b.com")).resolves.toBeUndefined();
  });
});
