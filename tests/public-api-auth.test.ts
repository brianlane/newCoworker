import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/api-keys", () => ({
  findActiveApiKeyByHash: vi.fn(),
  touchApiKeyLastUsed: vi.fn()
}));

import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { hashApiKey } from "@/lib/public-api/keys";
import { findActiveApiKeyByHash, touchApiKeyLastUsed } from "@/lib/db/api-keys";

const VALID_KEY = `nck_${"a".repeat(64)}`;
const KEY_ROW = {
  id: "key-1",
  business_id: "biz-1",
  name: "Zapier",
  key_prefix: "nck_aaaaaaaa",
  key_hash: hashApiKey(VALID_KEY),
  created_at: "2026-07-01T00:00:00Z",
  last_used_at: null,
  revoked_at: null
};

function req(auth?: string): Request {
  return new Request("http://localhost/api/public/v1/me", {
    headers: auth ? { authorization: auth } : {}
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticatePublicApiRequest", () => {
  it("returns business + key ids for a valid active key", async () => {
    vi.mocked(findActiveApiKeyByHash).mockResolvedValue(KEY_ROW);
    const auth = await authenticatePublicApiRequest(req(`Bearer ${VALID_KEY}`));
    expect(auth).toEqual({ businessId: "biz-1", apiKeyId: "key-1" });
    expect(findActiveApiKeyByHash).toHaveBeenCalledWith(hashApiKey(VALID_KEY));
    expect(touchApiKeyLastUsed).toHaveBeenCalledWith("key-1");
  });

  it("returns null without a DB lookup for malformed tokens", async () => {
    expect(await authenticatePublicApiRequest(req())).toBeNull();
    expect(await authenticatePublicApiRequest(req("Bearer garbage"))).toBeNull();
    expect(findActiveApiKeyByHash).not.toHaveBeenCalled();
  });

  it("returns null when the key is unknown or revoked", async () => {
    vi.mocked(findActiveApiKeyByHash).mockResolvedValue(null);
    expect(await authenticatePublicApiRequest(req(`Bearer ${VALID_KEY}`))).toBeNull();
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it("tolerates a failing last-used stamp (auth still succeeds)", async () => {
    vi.mocked(findActiveApiKeyByHash).mockResolvedValue(KEY_ROW);
    vi.mocked(touchApiKeyLastUsed).mockRejectedValue(new Error("db down"));
    const auth = await authenticatePublicApiRequest(req(`Bearer ${VALID_KEY}`));
    expect(auth).toEqual({ businessId: "biz-1", apiKeyId: "key-1" });
  });

  it("tolerates a non-Error stamp rejection too (String(err) branch)", async () => {
    vi.mocked(findActiveApiKeyByHash).mockResolvedValue(KEY_ROW);
    vi.mocked(touchApiKeyLastUsed).mockRejectedValue("plain string failure");
    const auth = await authenticatePublicApiRequest(req(`Bearer ${VALID_KEY}`));
    expect(auth).toEqual({ businessId: "biz-1", apiKeyId: "key-1" });
  });
});
