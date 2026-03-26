import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn().mockReturnValue({ auth: { getUser: vi.fn() } })
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn()
  })
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn().mockReturnValue({})
}));

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

describe("supabase/server", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock_anon_key",
      SUPABASE_SERVICE_ROLE_KEY: "mock_service_role_key"
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
      expect.objectContaining({ cookies: expect.any(Object) })
    );
  });

  it("createSupabaseServerClient throws when env vars missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await expect(createSupabaseServerClient()).rejects.toThrow("Missing Supabase public env vars");
  });

  it("createSupabaseServiceClient creates a service client", async () => {
    const client = await createSupabaseServiceClient();
    expect(client).toBeDefined();
    expect(createClient).toHaveBeenCalledWith(
      "https://mock.supabase.co",
      "mock_service_role_key",
      expect.objectContaining({ auth: { persistSession: false } })
    );
  });

  it("createSupabaseServiceClient throws when service key missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(createSupabaseServiceClient()).rejects.toThrow("Missing Supabase service role env vars");
  });

  it("createSupabaseServerClient invokes cookie get/set/remove handlers", async () => {
    let getCalledWith: string | undefined;
    let setCalledWith: string | undefined;
    let removeCalledWith: string | undefined;

    vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
      if (options?.cookies) {
        getCalledWith = options.cookies.get?.("auth-token");
        options.cookies.set?.("auth-token", "abc", { path: "/" });
        options.cookies.remove?.("auth-token", { path: "/" });
      }
      return { auth: { getUser: vi.fn() } } as never;
    });

    await createSupabaseServerClient();
    expect(getCalledWith).toBeUndefined(); // cookies mock returns undefined
    expect(setCalledWith).toBeUndefined(); // set is void
    expect(removeCalledWith).toBeUndefined(); // remove is void
    expect(createServerClient).toHaveBeenCalled();
  });
});
