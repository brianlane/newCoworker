import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { authUserExistsByEmail, getAuthUser, requireAuth, requireAdmin, requireOwner, verifySignupIdentity } from "@/lib/auth";

function mockSupabase(user: Record<string, unknown> | null, error: unknown = null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error })
    },
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: user ? { id: "biz-1" } : null })
  };
}

describe("auth", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, ADMIN_EMAIL: "admin@newcoworker.com" };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("getAuthUser returns null when no session", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase(null) as never
    );
    const result = await getAuthUser();
    expect(result).toBeNull();
  });

  it("getAuthUser returns null on error", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase(null, new Error("Session expired")) as never
    );
    const result = await getAuthUser();
    expect(result).toBeNull();
  });

  it("getAuthUser returns user with isAdmin=false for regular user", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "user-1", email: "user@test.com" }) as never
    );
    const result = await getAuthUser();
    expect(result?.userId).toBe("user-1");
    expect(result?.isAdmin).toBe(false);
  });

  it("getAuthUser returns isAdmin=true for admin email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "admin-1", email: "admin@newcoworker.com" }) as never
    );
    const result = await getAuthUser();
    expect(result?.isAdmin).toBe(true);
  });

  it("getAuthUser returns null email when user has no email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-no-email", email: undefined }) as never
    );
    const result = await getAuthUser();
    expect(result?.email).toBeNull();
    expect(result?.isAdmin).toBe(false);
  });

  it("getAuthUser is case-insensitive for admin email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "admin-1", email: "ADMIN@NEWCOWORKER.COM" }) as never
    );
    const result = await getAuthUser();
    expect(result?.isAdmin).toBe(true);
  });

  it("getAuthUser returns isAdmin=false when ADMIN_EMAIL not set", async () => {
    delete process.env.ADMIN_EMAIL;
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u", email: "any@test.com" }) as never
    );
    const result = await getAuthUser();
    expect(result?.isAdmin).toBe(false);
  });

  it("getAuthUser exposes phone when present", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "u@test.com", phone: "+15551234567" }) as never
    );
    const result = await getAuthUser();
    expect(result?.phone).toBe("+15551234567");
  });

  it("getAuthUser returns null phone when absent", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "u@test.com" }) as never
    );
    const result = await getAuthUser();
    expect(result?.phone).toBeNull();
  });

  it("getAuthUser treats blank phone as null", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "u@test.com", phone: "   " }) as never
    );
    const result = await getAuthUser();
    expect(result?.phone).toBeNull();
  });

  it("requireAuth throws 401 when no user", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase(null) as never
    );
    await expect(requireAuth()).rejects.toMatchObject({ status: 401 });
  });

  it("requireAuth returns user when authenticated", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "u@test.com" }) as never
    );
    const user = await requireAuth();
    expect(user.userId).toBe("u-1");
  });

  it("requireAdmin throws 403 for non-admin", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "regular@test.com" }) as never
    );
    await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
  });

  it("requireAdmin succeeds for admin email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "admin-1", email: "admin@newcoworker.com" }) as never
    );
    const user = await requireAdmin();
    expect(user.isAdmin).toBe(true);
  });

  it("requireOwner skips DB check for admin", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "admin-1", email: "admin@newcoworker.com" }) as never
    );
    const user = await requireOwner("some-biz-id");
    expect(user.isAdmin).toBe(true);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("requireOwner throws 403 when user has null email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-no-email", email: undefined }) as never
    );
    await expect(requireOwner("biz-1")).rejects.toMatchObject({ status: 403 });
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("requireOwner throws 403 for non-owner", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "notowner@test.com" }) as never
    );
    const mockServiceDb = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockServiceDb as never);

    await expect(requireOwner("biz-1")).rejects.toMatchObject({ status: 403 });
  });

  it("requireOwner returns user for verified owner", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "owner-1", email: "owner@test.com" }) as never
    );
    const mockServiceDb = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: "biz-1" }, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockServiceDb as never);

    const user = await requireOwner("biz-1");
    expect(user.userId).toBe("owner-1");
  });

  it("getAuthUser handles throw in createSupabaseServerClient", async () => {
    vi.mocked(createSupabaseServerClient).mockRejectedValue(new Error("env missing"));
    const result = await getAuthUser();
    expect(result).toBeNull();
  });

  it("verifySignupIdentity returns true when service user email matches case-insensitively", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      auth: {
        admin: {
          getUserById: vi.fn().mockResolvedValue({
            data: { user: { email: "Owner@Test.com" } },
            error: null
          })
        }
      }
    } as never);

    await expect(verifySignupIdentity("user-1", "owner@test.com")).resolves.toBe(true);
  });

  it("verifySignupIdentity returns false when admin lookup has no email", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      auth: {
        admin: {
          getUserById: vi.fn().mockResolvedValue({
            data: { user: { email: null } },
            error: null
          })
        }
      }
    } as never);

    await expect(verifySignupIdentity("user-1", "owner@test.com")).resolves.toBe(false);
  });

  it("verifySignupIdentity returns false when service client lookup throws", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("service unavailable"));
    await expect(verifySignupIdentity("user-1", "owner@test.com")).resolves.toBe(false);
  });

  describe("authUserExistsByEmail (strict variant)", () => {
    it("returns true when the RPC returns a user id", async () => {
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({ data: "user-1", error: null }),
        auth: { admin: { listUsers: vi.fn() } }
      } as never);

      await expect(authUserExistsByEmail("owner@test.com")).resolves.toBe(true);
    });

    it("returns false when the RPC returns null (definitive miss)", async () => {
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
        auth: { admin: { listUsers: vi.fn() } }
      } as never);

      await expect(authUserExistsByEmail("nobody@test.com")).resolves.toBe(false);
    });

    it("THROWS on a non-PGRST202 RPC error (fail-closed for security gates)", async () => {
      // Diverges from the soft `findAuthUserIdByEmail` which would
      // collapse this to null. The strict variant exists precisely so
      // /api/checkout's email-uniqueness gate fails closed on
      // transient lookup errors.
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "57014", message: "statement timeout" }
        }),
        auth: { admin: { listUsers: vi.fn() } }
      } as never);

      await expect(authUserExistsByEmail("owner@test.com")).rejects.toThrow(/lookup failed/i);
    });

    it("falls back to listUsers when the RPC is missing (PGRST202)", async () => {
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "PGRST202", message: "function does not exist" }
        }),
        auth: {
          admin: {
            listUsers: vi.fn().mockResolvedValue({
              data: { users: [{ id: "u-1", email: "Owner@Test.com" }] },
              error: null
            })
          }
        }
      } as never);

      await expect(authUserExistsByEmail("owner@test.com")).resolves.toBe(true);
    });

    it("returns false on a partial page that doesn't contain the target (definitive miss without exhausting the scan)", async () => {
      // Hits the `users.length < perPage` short-circuit: a single
      // partial page (< perPage users, none matching) is a definitive
      // miss — listing further pages would just churn admin API
      // calls. This branch is the common case for small / fresh
      // deployments that haven't applied the RPC migration yet, so
      // its correctness directly affects every legacy fallback miss.
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "PGRST202", message: "function does not exist" }
        }),
        auth: {
          admin: {
            listUsers: vi.fn().mockResolvedValue({
              data: {
                users: [
                  { id: "u-1", email: "someone@test.com" },
                  { id: "u-2", email: "another@test.com" }
                ]
              },
              error: null
            })
          }
        }
      } as never);

      await expect(authUserExistsByEmail("nobody@test.com")).resolves.toBe(false);
    });

    it("THROWS when the paginated scan exhausts PAGE_CAP without a definitive answer", async () => {
      // Pathological case: every page comes back FULL with the wrong
      // emails, meaning the cursor never reaches a definitive miss
      // and we never find the target. The strict variant must refuse
      // (throw) rather than silently report `false`, which would
      // re-open the security-gate bypass on legacy deployments
      // running with > PAGE_CAP * perPage = 2,000 users without the
      // RPC migration applied.
      const fullPage = Array.from({ length: 200 }, (_, i) => ({
        id: `u-${i}`,
        email: `user-${i}@test.com`
      }));
      const listUsers = vi.fn().mockResolvedValue({
        data: { users: fullPage },
        error: null
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "PGRST202", message: "function does not exist" }
        }),
        auth: { admin: { listUsers } }
      } as never);

      await expect(authUserExistsByEmail("nobody@test.com")).rejects.toThrow(
        /scan reached the cap/i
      );
      // 10 = PAGE_CAP. Pinning it here so any future loosening of the
      // cap is paired with a deliberate test update.
      expect(listUsers).toHaveBeenCalledTimes(10);
    });

    it("THROWS when listUsers fails on the legacy fallback path", async () => {
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "PGRST202", message: "function does not exist" }
        }),
        auth: {
          admin: {
            listUsers: vi
              .fn()
              .mockResolvedValue({ data: null, error: { message: "auth-admin offline" } })
          }
        }
      } as never);

      await expect(authUserExistsByEmail("owner@test.com")).rejects.toThrow(/lookup failed/i);
    });

    it("formats the RPC error fallback message when error.message is missing", async () => {
      // Branch coverage for the `?? "unknown error"` fallback in the
      // RPC error path. Some Postgres errors arrive with a code but
      // no human-readable message; the strict variant must still
      // produce an actionable thrown error rather than rendering
      // `undefined` into log lines.
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi
          .fn()
          .mockResolvedValue({ data: null, error: { code: "57014" } }),
        auth: { admin: { listUsers: vi.fn() } }
      } as never);

      await expect(authUserExistsByEmail("owner@test.com")).rejects.toThrow(
        /unknown error/i
      );
    });

    it("formats the listUsers error fallback message when pageError.message is missing", async () => {
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "PGRST202", message: "function does not exist" }
        }),
        auth: {
          admin: {
            // Error object intentionally has no `message` field — pins
            // the `?? "unknown error"` fallback in the listUsers
            // branch.
            listUsers: vi
              .fn()
              .mockResolvedValue({ data: null, error: { code: "PGRST301" } })
          }
        }
      } as never);

      await expect(authUserExistsByEmail("owner@test.com")).rejects.toThrow(
        /unknown error/i
      );
    });

    it("tolerates users with null/undefined email on the listUsers fallback (does not throw on the email comparison)", async () => {
      // Branch coverage for the `(u.email ?? "")` fallback inside
      // the page scan. Real auth.users rows occasionally carry null
      // emails (provider-only signups, post-deletion soft-tombstones,
      // historical rows) — the comparator must skip them rather than
      // throw on `null.toLowerCase()`.
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "PGRST202", message: "function does not exist" }
        }),
        auth: {
          admin: {
            listUsers: vi.fn().mockResolvedValue({
              data: {
                users: [
                  { id: "u-null", email: null },
                  { id: "u-real", email: "owner@test.com" }
                ]
              },
              error: null
            })
          }
        }
      } as never);

      await expect(authUserExistsByEmail("owner@test.com")).resolves.toBe(true);
    });

    it("returns false on an empty page (covers the `pageData?.users ?? []` fallback and the empty-page early return)", async () => {
      // Two adjacent branches in one test: listUsers resolves with a
      // null `data` payload (so the `?? []` defensive fallback runs)
      // and the resulting empty users array hits the
      // `users.length === 0` early-return. This is the "fewer users
      // than perPage and the FIRST page is empty" shape — a
      // freshly-provisioned auth schema, for instance.
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "PGRST202", message: "function does not exist" }
        }),
        auth: {
          admin: {
            listUsers: vi.fn().mockResolvedValue({ data: null, error: null })
          }
        }
      } as never);

      await expect(authUserExistsByEmail("owner@test.com")).resolves.toBe(false);
    });

    it("returns false on an empty trimmed email without hitting the DB", async () => {
      const rpc = vi.fn();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        rpc,
        auth: { admin: { listUsers: vi.fn() } }
      } as never);

      await expect(authUserExistsByEmail("   ")).resolves.toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
