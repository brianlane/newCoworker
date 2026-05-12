import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn().mockReturnValue({ auth: { getUser: vi.fn() } }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    getAll: vi.fn().mockReturnValue([]),
    set: vi.fn(),
  }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn().mockReturnValue({}),
}));

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

type CookieAdapter = {
  getAll?: () => unknown;
  setAll?: (cookies: { name: string; value: string; options?: Record<string, unknown> }[]) => void;
};

describe("supabase/server", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock_anon_key",
      SUPABASE_SERVICE_ROLE_KEY: "mock_service_role_key",
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("createSupabaseServerClient creates a server client", async () => {
    const client = await createSupabaseServerClient();
    expect(client).toBeDefined();
    expect(createServerClient).toHaveBeenCalledWith(
      "https://mock.supabase.co",
      "mock_anon_key",
      expect.objectContaining({ cookies: expect.any(Object) }),
    );
  });

  it("createSupabaseServerClient throws when env vars missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await expect(createSupabaseServerClient()).rejects.toThrow("Missing Supabase public env vars");
  });

  it("createSupabaseServerClient wires getAll/setAll cookie handlers", async () => {
    let sawGetAll = false;
    let setAllCalls = 0;

    vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
      const cookies = options?.cookies as CookieAdapter | undefined;
      if (cookies?.getAll) {
        sawGetAll = true;
        cookies.getAll();
      }
      cookies?.setAll?.([{ name: "x", value: "y", options: { path: "/" } }]);
      setAllCalls += 1;
      return { auth: { getUser: vi.fn() } } as never;
    });

    await createSupabaseServerClient();
    expect(sawGetAll).toBe(true);
    expect(setAllCalls).toBeGreaterThan(0);
    expect(createServerClient).toHaveBeenCalled();
  });

  it("createSupabaseServiceClient creates a service client", async () => {
    const client = await createSupabaseServiceClient();
    expect(client).toBeDefined();
    expect(createClient).toHaveBeenCalledWith(
      "https://mock.supabase.co",
      "mock_service_role_key",
      expect.objectContaining({ auth: { persistSession: false } }),
    );
  });

  it("createSupabaseServiceClient throws when service key missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(createSupabaseServiceClient()).rejects.toThrow("Missing Supabase service role env vars");
  });
});
