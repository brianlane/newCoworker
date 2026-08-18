/**
 * Meta's two required app callbacks: Deauthorize and Data Deletion Request
 * (src/app/api/webhooks/meta/*).
 *
 * Both are PUBLIC, unauthenticated endpoints by Meta's design, and the
 * `signed_request` HMAC is the entire security boundary. The properties
 * pinned here are the ones that make them safe and compliant:
 *   - a forged request severs nothing;
 *   - a real one severs every connection that person authorized;
 *   - Meta always gets a 200 with the documented body, because it never
 *     retries and treats anything else as a broken integration.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/meta/deauthorize", () => ({ deauthorizeMetaUser: vi.fn() }));
vi.mock("@/lib/meta/deletion-requests", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/deletion-requests")>(
    "@/lib/meta/deletion-requests"
  );
  return { ...actual, insertMetaDeletionRequest: vi.fn() };
});

import { POST as deauthorizePost } from "@/app/api/webhooks/meta/deauthorize/route";
import { POST as deletionPost } from "@/app/api/webhooks/meta/data-deletion/route";
import { deauthorizeMetaUser } from "@/lib/meta/deauthorize";
import { insertMetaDeletionRequest } from "@/lib/meta/deletion-requests";

const APP_SECRET = "test-app-secret";
const ASID = "122098495527401398";
const deauthorize = vi.mocked(deauthorizeMetaUser);
const insertRequest = vi.mocked(insertMetaDeletionRequest);

function sign(payload: unknown, secret = APP_SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  return `${sig}.${encoded}`;
}

/** A request shaped the way Meta actually posts: form-encoded. */
function req(url: string, signedRequest: string | null) {
  const body =
    signedRequest === null ? "" : new URLSearchParams({ signed_request: signedRequest }).toString();
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
}

const VALID = { algorithm: "HMAC-SHA256", issued_at: 1786400000, user_id: ASID };
const DEAUTH_URL = "https://app.test/api/webhooks/meta/deauthorize";
const DELETE_URL = "https://app.test/api/webhooks/meta/data-deletion";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  deauthorize.mockResolvedValue({ found: 1, cleared: 1, businessIds: ["b-1"], unmatched: false });
  insertRequest.mockResolvedValue({} as never);
});

describe("POST /api/webhooks/meta/deauthorize", () => {
  it("severs every connection that person authorized", async () => {
    const res = await deauthorizePost(req(DEAUTH_URL, sign(VALID)));
    expect(res.status).toBe(200);
    expect(deauthorize).toHaveBeenCalledWith(ASID, "deauthorize");
  });

  it("severs NOTHING when the signature is forged", async () => {
    // The attack the endpoint invites: anyone can POST here, so a bad
    // signature reaching deauthorizeMetaUser would let a stranger kill a
    // paying tenant's integration by guessing an app-scoped id.
    for (const bad of [
      sign(VALID, "attacker-secret"),
      "garbage",
      `${sign(VALID).split(".")[0]}.${Buffer.from('{"user_id":"9"}').toString("base64url")}`
    ]) {
      const res = await deauthorizePost(req(DEAUTH_URL, bad));
      expect(res.status).toBe(200);
    }
    expect(deauthorize).not.toHaveBeenCalled();
  });

  it("answers 200 on a missing field and an empty body", async () => {
    expect((await deauthorizePost(req(DEAUTH_URL, null))).status).toBe(200);
    expect(
      (await deauthorizePost(new Request(DEAUTH_URL, { method: "POST", body: "" }))).status
    ).toBe(200);
    expect(deauthorize).not.toHaveBeenCalled();
  });

  it("still answers 200 when the sever itself throws", async () => {
    // Meta does not retry, and a 500 here reads to Meta as a broken app.
    deauthorize.mockRejectedValue(new Error("db down"));
    expect((await deauthorizePost(req(DEAUTH_URL, sign(VALID)))).status).toBe(200);
  });
});

describe("POST /api/webhooks/meta/data-deletion", () => {
  it("returns Meta's documented body and records the request", async () => {
    const res = await deletionPost(req(DELETE_URL, sign(VALID)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };

    expect(body.confirmation_code).toMatch(/^[A-Z2-9]{12}$/);
    expect(body.url).toBe(
      `https://app.test/privacy/data-deletion/status?code=${body.confirmation_code}`
    );
    expect(deauthorize).toHaveBeenCalledWith(ASID, "data_deletion");
    expect(insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationCode: body.confirmation_code,
        metaUserId: ASID,
        connectionsCleared: 1,
        status: "completed"
      })
    );
  });

  it("records no_data when the person's id matches nothing we hold", async () => {
    // A complete answer, not a failure: they may have removed the app before
    // we recorded ids, or never finished connecting.
    deauthorize.mockResolvedValue({ found: 0, cleared: 0, businessIds: [], unmatched: true });
    await deletionPost(req(DELETE_URL, sign(VALID)));
    expect(insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: "no_data", connectionsCleared: 0 })
    );
  });

  it("records FAILED when connections matched but deletion did not finish", async () => {
    // The honesty case. Telling someone "we deleted everything" or "we held
    // nothing" while their data is still here are both lies to a person
    // exercising a privacy right, so a partial or total failure routes them
    // to a human instead.
    deauthorize.mockResolvedValue({ found: 2, cleared: 0, businessIds: [], unmatched: false });
    await deletionPost(req(DELETE_URL, sign(VALID)));
    expect(insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        detail: "matched 2 connection(s), deleted 0"
      })
    );

    vi.clearAllMocks();
    deauthorize.mockResolvedValue({ found: 3, cleared: 1, businessIds: ["b-1"], unmatched: false });
    await deletionPost(req(DELETE_URL, sign(VALID)));
    expect(insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        detail: "matched 3 connection(s), deleted 1"
      })
    );
  });

  it("records failed, and STILL answers Meta correctly, when the sever throws", async () => {
    deauthorize.mockRejectedValue(new Error("db down"));
    const res = await deletionPost(req(DELETE_URL, sign(VALID)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[A-Z2-9]{12}$/);
    expect(insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", detail: "db down" })
    );
  });

  it("deletes nothing on a forged signature but still answers in Meta's shape", async () => {
    // Meta's docs are explicit that a malformed answer can get the callback
    // removed or the app disabled, so even a refusal returns url + code.
    const res = await deletionPost(req(DELETE_URL, sign(VALID, "attacker-secret")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[A-Z2-9]{12}$/);
    expect(body.url).toContain("/privacy/data-deletion/status?code=");
    expect(deauthorize).not.toHaveBeenCalled();
    expect(insertRequest).not.toHaveBeenCalled();
  });

  it("still answers Meta when the ledger write fails", async () => {
    // The deletion already happened; losing the ledger row must not turn
    // into a non-200 that Meta reads as a broken callback.
    insertRequest.mockRejectedValue(new Error("insert failed"));
    const res = await deletionPost(req(DELETE_URL, sign(VALID)));
    expect(res.status).toBe(200);
    expect((await res.json()).confirmation_code).toMatch(/^[A-Z2-9]{12}$/);
  });

  it("issues a fresh code per request", async () => {
    const a = (await (await deletionPost(req(DELETE_URL, sign(VALID)))).json()).confirmation_code;
    const b = (await (await deletionPost(req(DELETE_URL, sign(VALID)))).json()).confirmation_code;
    expect(a).not.toBe(b);
  });

  it("falls back to the request origin when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const body = await (await deletionPost(req(DELETE_URL, sign(VALID)))).json();
    expect(body.url).toContain("https://app.test/privacy/data-deletion/status?code=");
  });
});
