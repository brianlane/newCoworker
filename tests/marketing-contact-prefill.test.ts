import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessId: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  CONTACT_TOPIC_DEFS_BY_PARAM,
  resolveContactPrefill
} from "@/lib/marketing/contact-prefill";

describe("resolveContactPrefill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns {} when signed out", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect(await resolveContactPrefill()).toEqual({});
  });

  it("returns email only when there is no active business", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      email: "ada@example.com",
      userId: "u1",
      isAdmin: false
    } as never);
    vi.mocked(resolveActiveBusinessId).mockResolvedValue(null);
    expect(await resolveContactPrefill()).toEqual({ email: "ada@example.com" });
  });

  it("prefills owner name and business when the login is the owner", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      email: "ada@example.com",
      userId: "u1",
      isAdmin: false
    } as never);
    vi.mocked(resolveActiveBusinessId).mockResolvedValue("biz-1");
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                name: "Analytical Engines",
                owner_name: "Ada Lovelace",
                owner_email: "ada@example.com"
              }
            })
          })
        })
      })
    } as never);

    expect(await resolveContactPrefill()).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      businessName: "Analytical Engines"
    });
  });

  it("omits name for non-owner team members", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      email: "teammate@example.com",
      userId: "u2",
      isAdmin: false
    } as never);
    vi.mocked(resolveActiveBusinessId).mockResolvedValue("biz-1");
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                name: "Analytical Engines",
                owner_name: "Ada Lovelace",
                owner_email: "ada@example.com"
              }
            })
          })
        })
      })
    } as never);

    expect(await resolveContactPrefill()).toEqual({
      email: "teammate@example.com",
      businessName: "Analytical Engines"
    });
  });
});

describe("CONTACT_TOPIC_DEFS_BY_PARAM", () => {
  it("covers the dashboard CTA topics", () => {
    expect(Object.keys(CONTACT_TOPIC_DEFS_BY_PARAM).sort()).toEqual([
      "enterprise",
      "support",
      "white-glove"
    ]);
  });
});
