import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FUB_API_BASE_URL,
  FUB_PAGE_LIMIT,
  FubApiError,
  createFubClient,
  extractCollection,
  retryAfterMs
} from "@/lib/fub-import/client";

type MockResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
};

function response(status: number, body: unknown, headers: Record<string, string> = {}): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body
  };
}

function makeFetch(responses: MockResponse[]) {
  const calls: { url: string; init: { method: string; headers: Record<string, string> } }[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string, init: unknown) => {
    calls.push({ url, init: init as { method: string; headers: Record<string, string> } });
    return responses[Math.min(i++, responses.length - 1)];
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const noSleep = vi.fn(async () => {});

beforeEach(() => {
  noSleep.mockClear();
  delete process.env.FUB_X_SYSTEM;
  delete process.env.FUB_X_SYSTEM_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("retryAfterMs", () => {
  it("parses seconds, caps at 30s, and falls back to 10s on junk", () => {
    expect(retryAfterMs("5")).toBe(5000);
    expect(retryAfterMs("999")).toBe(30_000);
    expect(retryAfterMs("0")).toBe(10_000);
    expect(retryAfterMs("-2")).toBe(10_000);
    expect(retryAfterMs("soon")).toBe(10_000);
    expect(retryAfterMs(null)).toBe(10_000);
  });
});

describe("extractCollection", () => {
  it("prefers the named key, falls back to the first non-metadata array", () => {
    expect(extractCollection({ people: [1, 2], _metadata: {} }, "people")).toEqual([1, 2]);
    expect(extractCollection({ _metadata: { total: 1 }, actionPlans: [3] }, "actionplans")).toEqual([
      3
    ]);
    expect(extractCollection({ _metadata: {}, nothing: "here" }, "people")).toEqual([]);
    expect(extractCollection(null, "people")).toEqual([]);
    expect(extractCollection("nope", "people")).toEqual([]);
  });
});

describe("createFubClient", () => {
  it("authenticates with the key as the Basic username and a blank password", async () => {
    const { impl, calls } = makeFetch([response(200, { name: "Amy Agent" })]);
    const client = createFubClient({ apiKey: "sekret", fetchImpl: impl, sleep: noSleep });
    const me = await client.ping();
    expect(me).toEqual({ name: "Amy Agent" });
    expect(calls[0].url).toBe(`${FUB_API_BASE_URL}/me`);
    expect(calls[0].init.headers.Authorization).toBe(
      `Basic ${Buffer.from("sekret:").toString("base64")}`
    );
    expect(calls[0].init.headers.Accept).toBe("application/json");
    expect(calls[0].init.headers["X-System"]).toBeUndefined();
    expect(calls[0].init.headers["X-System-Key"]).toBeUndefined();
  });

  it("ping tolerates a body without a usable name", async () => {
    const { impl } = makeFetch([response(200, {})]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    expect(await client.ping()).toEqual({ name: null });
    const { impl: impl2 } = makeFetch([response(200, null)]);
    const client2 = createFubClient({ apiKey: "k", fetchImpl: impl2, sleep: noSleep });
    expect(await client2.ping()).toEqual({ name: null });
  });

  it("sends X-System headers from options, preferring them over env", async () => {
    process.env.FUB_X_SYSTEM = "EnvSystem";
    process.env.FUB_X_SYSTEM_KEY = "EnvKey";
    const { impl, calls } = makeFetch([response(200, {})]);
    const client = createFubClient({
      apiKey: "k",
      fetchImpl: impl,
      sleep: noSleep,
      system: "OptSystem",
      systemKey: null
    });
    await client.ping();
    expect(calls[0].init.headers["X-System"]).toBe("OptSystem");
    expect(calls[0].init.headers["X-System-Key"]).toBeUndefined();
  });

  it("sends X-System headers from env when options leave them undefined", async () => {
    process.env.FUB_X_SYSTEM = "EnvSystem";
    process.env.FUB_X_SYSTEM_KEY = "EnvKey";
    const { impl, calls } = makeFetch([response(200, {})]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    await client.ping();
    expect(calls[0].init.headers["X-System"]).toBe("EnvSystem");
    expect(calls[0].init.headers["X-System-Key"]).toBe("EnvKey");
  });

  it("waits Retry-After on 429 then retries, using the injected sleep", async () => {
    const { impl, calls } = makeFetch([
      response(429, {}, { "Retry-After": "2" }),
      response(200, { people: [], _metadata: { total: 0 } })
    ]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    const page = await client.getPeople({ limit: 1 });
    expect(page.total).toBe(0);
    expect(noSleep).toHaveBeenCalledWith(2000);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the retry budget and surfaces the 429 without the key", async () => {
    const { impl, calls } = makeFetch([response(429, {}, {})]);
    const client = createFubClient({ apiKey: "hushhush", fetchImpl: impl, sleep: noSleep });
    const err = await client.getPeople({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FubApiError);
    expect((err as FubApiError).status).toBe(429);
    expect((err as FubApiError).message).not.toContain("hushhush");
    // initial try + 3 retries
    expect(calls).toHaveLength(4);
    expect(noSleep).toHaveBeenCalledTimes(3);
  });

  it("throws FubApiError with status and path (never the body) on other failures", async () => {
    const { impl } = makeFetch([response(500, { secret: "stuff" })]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    const err = await client.getDeals({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FubApiError);
    expect((err as FubApiError).message).toBe("Follow Up Boss API responded 500 on /deals");
  });

  it("paginates with offset first, then the keyset next token", async () => {
    const { impl, calls } = makeFetch([
      response(200, { people: [{ id: 1 }], _metadata: { total: 2, next: "tok1" } }),
      response(200, { people: [{ id: 2 }], _metadata: { total: 2 } })
    ]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    const first = await client.getPeople({ limit: 1, offset: 0, fields: "id" });
    expect(first.items).toEqual([{ id: 1 }]);
    expect(first.next).toBe("tok1");
    const url1 = new URL(calls[0].url);
    expect(url1.searchParams.get("offset")).toBe("0");
    expect(url1.searchParams.get("next")).toBeNull();
    expect(url1.searchParams.get("fields")).toBe("id");

    const second = await client.getPeople({ limit: 1, next: "tok1" });
    expect(second.items).toEqual([{ id: 2 }]);
    expect(second.next).toBeNull();
    const url2 = new URL(calls[1].url);
    expect(url2.searchParams.get("next")).toBe("tok1");
    expect(url2.searchParams.get("offset")).toBeNull();
  });

  it("defaults the page limit, skips undefined params, and ignores an empty next token", async () => {
    const { impl, calls } = makeFetch([
      response(200, { notes: [], _metadata: { next: "", total: "many" } })
    ]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    const page = await client.getNotes({});
    expect(page).toEqual({ items: [], total: null, next: null });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("limit")).toBe(String(FUB_PAGE_LIMIT));
    expect(url.searchParams.get("fields")).toBeNull();
  });

  it("tolerates a response with no _metadata at all", async () => {
    const { impl } = makeFetch([response(200, { stages: [{ id: 1 }] })]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    const page = await client.getStages({ limit: 10 });
    expect(page).toEqual({ items: [{ id: 1 }], total: null, next: null });
  });

  it("tolerates a non-object response body", async () => {
    const { impl } = makeFetch([response(200, "totally not json-shaped")]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    const page = await client.getStages({});
    expect(page).toEqual({ items: [], total: null, next: null });
  });

  it("drops params passed explicitly as undefined", async () => {
    const { impl, calls } = makeFetch([response(200, { people: [] })]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    await client.getPeople({ limit: 1, fields: undefined });
    expect(new URL(calls[0].url).searchParams.has("fields")).toBe(false);
  });

  it("getPeopleByIds batches by comma-joined id filter", async () => {
    const { impl, calls } = makeFetch([
      response(200, { people: [{ id: 5 }, { id: 6 }], _metadata: {} })
    ]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    const page = await client.getPeopleByIds([5, 6], "id,phones");
    expect(page.items).toHaveLength(2);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("id")).toBe("5,6");
    expect(url.searchParams.get("fields")).toBe("id,phones");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("asks smartLists for every list (all=true) and reads pipelines/actionPlans", async () => {
    const { impl, calls } = makeFetch([
      response(200, { smartlists: [{ id: 1, name: "Hot" }], _metadata: {} }),
      response(200, { pipelines: [{ id: 2, stages: [] }], _metadata: {} }),
      response(200, { actionplans: [{ id: 3, name: "Nurture" }], _metadata: {} })
    ]);
    const client = createFubClient({ apiKey: "k", fetchImpl: impl, sleep: noSleep });
    expect((await client.getSmartLists({})).items).toEqual([{ id: 1, name: "Hot" }]);
    expect(new URL(calls[0].url).searchParams.get("all")).toBe("true");
    expect(new URL(calls[0].url).pathname.endsWith("/smartLists")).toBe(true);
    expect((await client.getPipelines({})).items).toEqual([{ id: 2, stages: [] }]);
    expect((await client.getActionPlans({})).items).toEqual([{ id: 3, name: "Nurture" }]);
  });

  it("honors a custom base URL", async () => {
    const { impl, calls } = makeFetch([response(200, {})]);
    const client = createFubClient({
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      fetchImpl: impl,
      sleep: noSleep
    });
    await client.ping();
    expect(calls[0].url).toBe("https://example.test/v1/me");
  });

  it("uses global fetch and a real timer sleep when none are injected", async () => {
    vi.useFakeTimers();
    const { impl, calls } = makeFetch([
      response(429, {}, { "Retry-After": "1" }),
      response(200, { name: "ok" })
    ]);
    vi.stubGlobal("fetch", impl);
    const client = createFubClient({ apiKey: "k" });
    const pending = client.ping();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ name: "ok" });
    expect(calls).toHaveLength(2);
  });
});
