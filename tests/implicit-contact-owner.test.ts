/**
 * Implicit contact ownership (src/lib/contacts/owner-attribution.ts and
 * src/lib/db/implicit-contact-owner.ts).
 *
 * The defect (HQ, Aug 18 2026): HQ's roster is one row, Brian, who is the
 * owner. Every contact page therefore offered "Nobody (unowned)" as the
 * default answer to a question with exactly one possible answer, the Task
 * Center called every lead unassigned, and the booking alert asked the owner
 * to hand the appointment to a teammate who does not exist.
 *
 * Two claims are load-bearing and asserted here: the rule only fires when
 * the sole ACTIVE member is provably the owner (so a solo business with an
 * assistant keeps its real unowned leads), and the resolver never throws,
 * because every surface calling it would rather show "unowned" than 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/contact-names", () => ({ businessOwnerNumbers: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ listTeamMembers: vi.fn() }));

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  effectiveContactOwner,
  pickImplicitContactOwner
} from "@/lib/contacts/owner-attribution";
import { resolveImplicitContactOwner } from "@/lib/db/implicit-contact-owner";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { listTeamMembers } from "@/lib/db/employees";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER_PHONE = "+16026951142";

const owner = (over: Record<string, unknown> = {}) => ({
  id: "mem-owner",
  name: "Brian",
  phone_e164: OWNER_PHONE,
  active: true,
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(businessOwnerNumbers).mockResolvedValue([OWNER_PHONE]);
});

describe("pickImplicitContactOwner", () => {
  it("names the sole active member when their roster phone is an owner number", () => {
    expect(pickImplicitContactOwner([owner()], [OWNER_PHONE])).toEqual({
      id: "mem-owner",
      name: "Brian"
    });
  });

  it("declines when a second active member could take the lead", () => {
    const members = [owner(), owner({ id: "mem-2", phone_e164: "+15555550102" })];
    expect(pickImplicitContactOwner(members, [OWNER_PHONE])).toBeNull();
  });

  it("declines when the roster is empty", () => {
    expect(pickImplicitContactOwner([], [OWNER_PHONE])).toBeNull();
  });

  it("declines when the sole member is an assistant, not the owner", () => {
    // The owner really can hand this lead over, so "nobody holds it" is news.
    const assistant = owner({ id: "mem-a", name: "Dana", phone_e164: "+15555550199" });
    expect(pickImplicitContactOwner([assistant], [OWNER_PHONE])).toBeNull();
  });

  it("ignores inactive rows on both sides of the count", () => {
    // Hired one person, offboarded them: back to one-person, and the
    // offboarded row must never inherit every contact.
    const members = [owner(), owner({ id: "mem-gone", active: false })];
    expect(pickImplicitContactOwner(members, [OWNER_PHONE])).toEqual({
      id: "mem-owner",
      name: "Brian"
    });
    const goneOnly = [owner({ id: "mem-gone", active: false })];
    expect(pickImplicitContactOwner(goneOnly, [OWNER_PHONE])).toBeNull();
  });

  it("declines when the business has no owner number on file", () => {
    expect(pickImplicitContactOwner([owner()], [])).toBeNull();
  });

  it("falls back to 'Owner' for a blank or missing roster name", () => {
    expect(pickImplicitContactOwner([owner({ name: "  " })], [OWNER_PHONE])?.name).toBe(
      "Owner"
    );
    expect(pickImplicitContactOwner([owner({ name: null })], [OWNER_PHONE])?.name).toBe(
      "Owner"
    );
  });
});

describe("effectiveContactOwner", () => {
  const implicit = { id: "mem-owner", name: "Brian" };

  it("keeps an explicit stamp, and names it from the roster map", () => {
    const map = new Map([["mem-2", "Dana Reyes"]]);
    expect(effectiveContactOwner("mem-2", implicit, map)).toEqual({
      id: "mem-2",
      name: "Dana Reyes"
    });
  });

  it("leaves a stamped id whose roster row is gone unnamed, as before", () => {
    expect(effectiveContactOwner("mem-deleted", implicit, new Map())).toEqual({
      id: "mem-deleted",
      name: null
    });
    expect(effectiveContactOwner("mem-deleted", implicit)).toEqual({
      id: "mem-deleted",
      name: null
    });
  });

  it("falls to the implicit owner only when nothing is stamped", () => {
    expect(effectiveContactOwner(null, implicit)).toEqual(implicit);
    expect(effectiveContactOwner(undefined, implicit)).toEqual(implicit);
  });

  it("answers nobody when there is no stamp and no implicit owner", () => {
    expect(effectiveContactOwner(null, null)).toBeNull();
  });
});

describe("resolveImplicitContactOwner", () => {
  it("resolves a one-person owner roster", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([owner()] as never);
    const db = {} as never;
    await expect(resolveImplicitContactOwner(BIZ, db)).resolves.toEqual({
      id: "mem-owner",
      name: "Brian"
    });
    expect(listTeamMembers).toHaveBeenCalledWith(BIZ, db);
  });

  it("skips the three owner-number reads when a real team exists", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([
      owner(),
      owner({ id: "mem-2", phone_e164: "+15555550102" })
    ] as never);
    await expect(resolveImplicitContactOwner(BIZ, {} as never)).resolves.toBeNull();
    expect(businessOwnerNumbers).not.toHaveBeenCalled();
  });

  it("uses a roster the caller already loaded instead of reading it again", async () => {
    await expect(
      resolveImplicitContactOwner(BIZ, {} as never, [owner()])
    ).resolves.toEqual({ id: "mem-owner", name: "Brian" });
    expect(listTeamMembers).not.toHaveBeenCalled();
  });

  it("answers null and warns when the roster read fails, never throwing", async () => {
    vi.mocked(listTeamMembers).mockRejectedValue(new Error("roster down"));
    await expect(resolveImplicitContactOwner(BIZ, {} as never)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("implicit contact owner"),
      expect.objectContaining({ businessId: BIZ, error: "roster down" })
    );
  });

  it("stringifies a non-Error failure rather than logging [object Object]", async () => {
    vi.mocked(listTeamMembers).mockRejectedValue("nope");
    await expect(resolveImplicitContactOwner(BIZ, {} as never)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "nope" })
    );
  });

  it("falls back to createSupabaseServiceClient when no client is injected", async () => {
    // Injecting a client skips the `?? await createSupabaseServiceClient()`
    // branch entirely, so this path needs its own case.
    vi.mocked(listTeamMembers).mockResolvedValue([owner()] as never);
    defaultClientSpy.mockReturnValue({ from: vi.fn() });
    await expect(resolveImplicitContactOwner(BIZ)).resolves.toEqual({
      id: "mem-owner",
      name: "Brian"
    });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
