import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postBusinessConfigSave } from "@/lib/business-config-save-client";

describe("postBusinessConfigSave", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns ok:true on HTTP 200", async () => {
    const out = await postBusinessConfigSave({ soulMd: "hello", businessId: "00000000-0000-4000-8000-000000000001" });

    expect(out).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/business/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        soulMd: "hello",
        businessId: "00000000-0000-4000-8000-000000000001"
      })
    });
  });

  it("returns structured error.message when HTTP error and payload ok:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: { message: "bad request" } }), {
            status: 422,
            headers: { "content-type": "application/json" }
          })
      )
    );

    await expect(postBusinessConfigSave({})).resolves.toEqual({
      ok: false,
      errorMessage: "bad request"
    });
  });

  it("returns Save failed when HTTP error omits error.message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: {} }), {
            status: 400,
            headers: { "content-type": "application/json" }
          })
      )
    );

    await expect(postBusinessConfigSave({})).resolves.toEqual({
      ok: false,
      errorMessage: "Save failed"
    });
  });

  it("returns Save failed when JSON body cannot be parsed on error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 500, headers: { "content-type": "text/plain" } }))
    );

    await expect(postBusinessConfigSave({})).resolves.toEqual({
      ok: false,
      errorMessage: "Save failed"
    });
  });

  it("returns Error message when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable");
      })
    );

    await expect(postBusinessConfigSave({})).resolves.toEqual({
      ok: false,
      errorMessage: "network unavailable"
    });
  });

  it("returns a generic connection message when fetch rejects a non-Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "boom";
      })
    );

    await expect(postBusinessConfigSave({})).resolves.toEqual({
      ok: false,
      errorMessage: "Could not save. Check your connection and try again."
    });
  });
});
