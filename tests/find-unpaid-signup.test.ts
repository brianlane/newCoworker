import { describe, expect, it, vi } from "vitest";

// Mocked to RESOLVE a stub, and the tests below call with no client argument.
// Passing a client explicitly makes the `?? await` short-circuit, and v8 then
// reports every statement after that await as uncovered even though the test
// ran all of it (PR #1458). One test at the end covers the injected side.
const { createSupabaseServiceClient } = vi.hoisted(() => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient }));
vi.mock("@/lib/stripe/client", () => ({
  resolvePriceId: vi.fn(() => "price_test"),
  resolveIntroDiscountCouponId: vi.fn(() => undefined),
  createCheckoutSession: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { findUnpaidSignupByContact } from "@/lib/billing/signup-payment-link";

const KIN = "a912aff5-dd87-49fb-ad6a-477acefb66c0";

function biz(overrides: Record<string, unknown> = {}) {
  return {
    id: KIN,
    name: "KIN Integrated Child Health",
    owner_email: `pending+${KIN}@onboarding.local`,
    status: "offline",
    created_at: "2026-08-21T21:35:34.393Z",
    phone: "+17807076365",
    customer_profile_id: "profile-1",
    ...overrides
  };
}

/** Chainable fake: from(table).select().eq()[.maybeSingle()]. */
function makeDb(rows: Record<string, unknown>) {
  return {
    from(table: string) {
      const outcome = rows[table] ?? { data: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => outcome,
        then: (resolve: (v: unknown) => unknown) => resolve(outcome)
      };
      return chain;
    }
  } as never;
}

describe("findUnpaidSignupByContact", () => {
  it("finds the unpaid signup by the phone the prospect is texting from", async () => {
    createSupabaseServiceClient.mockResolvedValue(makeDb({ businesses: { data: [biz()] } }));
    const found = await findUnpaidSignupByContact({ phone: "+17807076365" });
    expect(found?.id).toBe(KIN);
  });

  it("falls back to the email they signed up with, via the customer profile", async () => {
    let call = 0;
    const db = {
      from(table: string) {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: { id: "profile-1" } }),
          then: (resolve: (v: unknown) => unknown) => {
            if (table === "businesses") {
              call += 1;
              // First pass is the phone lookup (no phone given → not called),
              // so any businesses read here is the profile-scoped one.
              return resolve({ data: [biz()] });
            }
            return resolve({ data: null });
          }
        };
        return chain;
      }
    } as never;
    createSupabaseServiceClient.mockResolvedValue(db);
    const found = await findUnpaidSignupByContact({ email: "King@KinIntegrated.com " });
    expect(found?.id).toBe(KIN);
    expect(call).toBe(1);
  });

  // The whole safety property: a real tenant can never be matched, because
  // the sentinel is one-way and a paid account has swapped it for a real
  // address.
  it("never returns a business whose owner has claimed it", async () => {
    createSupabaseServiceClient.mockResolvedValue(
      makeDb({ businesses: { data: [biz({ owner_email: "amy@amylaidlaw.com" })] } })
    );
    expect(await findUnpaidSignupByContact({ phone: "+17807076365" })).toBeNull();
  });

  it("never returns a business that is already online", async () => {
    createSupabaseServiceClient.mockResolvedValue(
      makeDb({ businesses: { data: [biz({ status: "online" })] } })
    );
    expect(await findUnpaidSignupByContact({ phone: "+17807076365" })).toBeNull();
  });

  it("returns the newest attempt when a prospect restarted signup", async () => {
    const older = biz({ id: "11111111-1111-4111-8111-111111111111", created_at: "2026-08-01T00:00:00Z" });
    older.owner_email = "pending+11111111-1111-4111-8111-111111111111@onboarding.local";
    createSupabaseServiceClient.mockResolvedValue(makeDb({ businesses: { data: [older, biz()] } }));
    const found = await findUnpaidSignupByContact({ phone: "+17807076365" });
    expect(found?.id).toBe(KIN);
  });

  it("returns null when nothing matches", async () => {
    createSupabaseServiceClient.mockResolvedValue(makeDb({ businesses: { data: [] } }));
    expect(await findUnpaidSignupByContact({ phone: "+15550000000" })).toBeNull();
  });

  it("returns null when neither phone nor email is supplied", async () => {
    createSupabaseServiceClient.mockResolvedValue(makeDb({}));
    expect(await findUnpaidSignupByContact({})).toBeNull();
  });

  it("returns null when the email has no customer profile", async () => {
    const db = {
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null })
        };
        return chain;
      }
    } as never;
    createSupabaseServiceClient.mockResolvedValue(db);
    expect(await findUnpaidSignupByContact({ email: "nobody@example.com" })).toBeNull();
  });

  it("does not consult email when the phone already matched", async () => {
    let profileReads = 0;
    const db = {
      from(table: string) {
        if (table === "customer_profiles") profileReads += 1;
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: { id: "profile-1" } }),
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: table === "businesses" ? [biz()] : null })
        };
        return chain;
      }
    } as never;
    createSupabaseServiceClient.mockResolvedValue(db);
    await findUnpaidSignupByContact({ phone: "+17807076365", email: "king@kinintegrated.com" });
    expect(profileReads).toBe(0);
  });

  // PostgREST can answer with a null body rather than an empty array.
  it("treats a null phone-lookup body as no match", async () => {
    createSupabaseServiceClient.mockResolvedValue(makeDb({ businesses: { data: null } }));
    expect(await findUnpaidSignupByContact({ phone: "+17807076365" })).toBeNull();
  });

  it("treats a null profile-scoped lookup body as no match", async () => {
    const db = {
      from(table: string) {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: { id: "profile-1" } }),
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: table === "businesses" ? null : { id: "profile-1" } })
        };
        return chain;
      }
    } as never;
    createSupabaseServiceClient.mockResolvedValue(db);
    expect(await findUnpaidSignupByContact({ email: "king@kinintegrated.com" })).toBeNull();
  });

  // Covers the left side of `client ?? await createSupabaseServiceClient()`.
  it("uses an injected client without creating a service client", async () => {
    createSupabaseServiceClient.mockReset();
    const db = makeDb({ businesses: { data: [biz()] } });
    const found = await findUnpaidSignupByContact({ phone: "+17807076365" }, { client: db });
    expect(found?.id).toBe(KIN);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
