import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexNowKey, KEY_FILE_PATH, submitToIndexNow } from "@/lib/marketing/indexnow";
import { GET as keyFileGet } from "@/app/indexnow-key.txt/route";

const KEY = "a1b2c3d4e5f6a7b8";

beforeEach(() => {
  vi.stubEnv("INDEXNOW_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200 });
}

describe("indexNowKey", () => {
  it("reads the env key, trimmed", () => {
    vi.stubEnv("INDEXNOW_KEY", `  ${KEY}  `);
    expect(indexNowKey()).toBe(KEY);
  });

  it("is null when unset or blank, which turns the feature off", () => {
    vi.stubEnv("INDEXNOW_KEY", "");
    expect(indexNowKey()).toBeNull();
    vi.stubEnv("INDEXNOW_KEY", "   ");
    expect(indexNowKey()).toBeNull();
    vi.stubEnv("INDEXNOW_KEY", undefined);
    expect(indexNowKey()).toBeNull();
  });
});

describe("submitToIndexNow", () => {
  it("posts the batch with the key file location", async () => {
    const fetchImpl = okFetch();
    const outcome = await submitToIndexNow(
      ["https://newcoworker.com/blog/a", "https://newcoworker.com/blog"],
      { fetchImpl: fetchImpl as never }
    );

    expect(outcome).toEqual({ status: "sent", submitted: 2, httpStatus: 200 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(init.body)).toEqual({
      host: "newcoworker.com",
      key: KEY,
      keyLocation: `https://newcoworker.com${KEY_FILE_PATH}`,
      urlList: ["https://newcoworker.com/blog/a", "https://newcoworker.com/blog"]
    });
  });

  it("does nothing at all without a key", async () => {
    vi.stubEnv("INDEXNOW_KEY", undefined);
    const fetchImpl = okFetch();
    const outcome = await submitToIndexNow(["https://newcoworker.com/x"], {
      fetchImpl: fetchImpl as never
    });
    expect(outcome).toEqual({ status: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a malformed key rather than earning a 403", async () => {
    vi.stubEnv("INDEXNOW_KEY", "too short");
    const fetchImpl = okFetch();
    const outcome = await submitToIndexNow(["https://newcoworker.com/x"], {
      fetchImpl: fetchImpl as never
    });
    expect(outcome).toEqual({ status: "invalid-key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops URLs from other hosts, since a mixed batch is rejected wholesale", async () => {
    const fetchImpl = okFetch();
    const outcome = await submitToIndexNow(
      [
        "https://newcoworker.com/blog/a",
        "https://example.com/elsewhere",
        "https://newcoworker.com/blog"
      ],
      { fetchImpl: fetchImpl as never }
    );

    expect(outcome).toEqual({ status: "sent", submitted: 2, httpStatus: 200 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).urlList).toEqual([
      "https://newcoworker.com/blog/a",
      "https://newcoworker.com/blog"
    ]);
  });

  it("skips when there is nothing submittable", async () => {
    const fetchImpl = okFetch();
    expect(await submitToIndexNow([], { fetchImpl: fetchImpl as never })).toEqual({
      status: "skipped",
      reason: "no-urls"
    });
    expect(await submitToIndexNow(["not-a-url"], { fetchImpl: fetchImpl as never })).toEqual({
      status: "skipped",
      reason: "no-urls"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a rejection without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const outcome = await submitToIndexNow(["https://newcoworker.com/x"], {
      fetchImpl: fetchImpl as never
    });
    expect(outcome).toEqual({ status: "failed", error: "HTTP 403" });
  });

  it("reports a transport failure without throwing", async () => {
    const outcome = await submitToIndexNow(["https://newcoworker.com/x"], {
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNRESET")) as never
    });
    expect(outcome).toEqual({ status: "failed", error: "ECONNRESET" });

    const thrownString = await submitToIndexNow(["https://newcoworker.com/x"], {
      fetchImpl: vi.fn().mockRejectedValue("socket hang up") as never
    });
    expect(thrownString).toEqual({ status: "failed", error: "socket hang up" });
  });
});

describe("the key file route", () => {
  it("serves the key as plain text so the engines can verify ownership", async () => {
    const res = keyFileGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(KEY);
  });

  it("404s when the feature is off, rather than serving an empty file", async () => {
    vi.stubEnv("INDEXNOW_KEY", undefined);
    expect(keyFileGet().status).toBe(404);
  });
});
