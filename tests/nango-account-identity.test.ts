import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxy = vi.fn();
const mockWorkspaceProxy = vi.fn();

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: (...a: unknown[]) => mockProxy(...a)
}));
vi.mock("@/lib/workspace/proxy", () => ({
  workspaceProxyForBusiness: (...a: unknown[]) => mockWorkspaceProxy(...a)
}));

import {
  fetchProviderAccountIdentity,
  fetchWorkspaceAccountIdentity,
  identityAttemptsForProviderKey,
  nangoIdentityPatchBody,
  providerAccountMetadata
} from "@/lib/nango/account-identity";

const BIZ = "b1";

function link(providerConfigKey: string) {
  return { connectionId: "cx", providerConfigKey };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("identityAttemptsForProviderKey", () => {
  it("maps provider keys (case-insensitively) to probe endpoints", () => {
    expect(identityAttemptsForProviderKey("gmail").map((a) => a.endpoint)).toEqual([
      "/gmail/v1/users/me/profile"
    ]);
    expect(identityAttemptsForProviderKey("google-mail").map((a) => a.endpoint)).toEqual([
      "/gmail/v1/users/me/profile"
    ]);
    expect(identityAttemptsForProviderKey("Google").map((a) => a.endpoint)).toEqual([
      "/gmail/v1/users/me/profile",
      "/calendar/v3/calendars/primary"
    ]);
    expect(identityAttemptsForProviderKey("google-calendar").map((a) => a.endpoint)).toEqual([
      "/calendar/v3/calendars/primary"
    ]);
    expect(identityAttemptsForProviderKey("outlook").map((a) => a.endpoint)).toEqual(["/v1.0/me"]);
    expect(identityAttemptsForProviderKey("outlook-calendar").map((a) => a.endpoint)).toEqual([
      "/v1.0/me"
    ]);
    expect(identityAttemptsForProviderKey("onedrive").map((a) => a.endpoint)).toEqual(["/v1.0/me"]);
    expect(identityAttemptsForProviderKey("zoom").map((a) => a.endpoint)).toEqual(["/v2/users/me"]);
    expect(identityAttemptsForProviderKey("calendly").map((a) => a.endpoint)).toEqual(["/users/me"]);
    expect(identityAttemptsForProviderKey("slack")).toEqual([]);
  });
});

describe("fetchProviderAccountIdentity", () => {
  it("reads the Gmail profile emailAddress", async () => {
    mockProxy.mockResolvedValue({ data: { emailAddress: " real@gmail.com " } });
    await expect(fetchProviderAccountIdentity(BIZ, link("gmail"))).resolves.toEqual({
      email: "real@gmail.com",
      displayName: null,
      // The Gmail profile has no account id to offer; only Graph and Zoom do.
      accountId: null
    });
    expect(mockProxy).toHaveBeenCalledWith(BIZ, link("gmail"), {
      endpoint: "/gmail/v1/users/me/profile",
      method: "GET"
    });
  });

  it("broad google: falls back to the primary calendar id when the gmail probe fails", async () => {
    mockProxy
      .mockRejectedValueOnce(new Error("insufficient scope"))
      .mockResolvedValueOnce({ data: { id: "real@gmail.com", summary: "Real Name" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("google"))).resolves.toEqual({
      email: "real@gmail.com",
      displayName: "Real Name",
      // The calendar `id` IS the email, not an account id; claiming it as one
      // would hand the reconnect veto a string that is not comparable across
      // representations.
      accountId: null
    });
    expect(mockProxy).toHaveBeenCalledTimes(2);
  });

  it("broad google: skips a probe whose payload has nothing usable", async () => {
    mockProxy
      .mockResolvedValueOnce({ data: { historyId: "123" } })
      .mockResolvedValueOnce({ data: { id: "real@gmail.com" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("google"))).resolves.toEqual({
      email: "real@gmail.com",
      displayName: null,
      accountId: null
    });
  });

  it("microsoft: uses mail, falling back to userPrincipalName, and keeps the Graph id", async () => {
    // The id is what lets the reconnect veto tell two accounts sharing an
    // address apart, so the probe must not drop it on the floor.
    mockProxy.mockResolvedValue({
      data: {
        id: "graph-object-1",
        mail: "owner@contoso.com",
        userPrincipalName: "upn@contoso.com",
        displayName: "Owner"
      }
    });
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook"))).resolves.toEqual({
      email: "owner@contoso.com",
      displayName: "Owner",
      accountId: "graph-object-1"
    });

    mockProxy.mockResolvedValue({
      data: { mail: null, userPrincipalName: "upn@contoso.com" }
    });
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook-calendar"))).resolves.toEqual({
      email: "upn@contoso.com",
      displayName: null,
      accountId: null
    });
  });

  it("microsoft: display name alone still identifies the account", async () => {
    mockProxy.mockResolvedValue({ data: { displayName: "Owner Only" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("onedrive"))).resolves.toEqual({
      email: null,
      displayName: "Owner Only",
      accountId: null
    });
  });

  it("microsoft: an id alone is a FAILED probe, not an identity", async () => {
    // Bugbot on #1355. If an id-only payload counted as success, the nango
    // complete route's wholesale identity replace would wipe the stored email
    // and display name off a live row on re-complete: labels vanish from
    // every surface, and at-cap consolidation (keyed on identity.email)
    // silently never runs. The id ENRICHES a probe that resolved a name for
    // the account; it must never turn a nameless payload into one.
    mockProxy.mockResolvedValue({ data: { id: "graph-object-2" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
  });

  it("microsoft: an empty Graph payload returns the null identity", async () => {
    mockProxy.mockResolvedValue({ data: {} });
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
  });

  it("google-calendar: a payload without an id returns the null identity", async () => {
    mockProxy.mockResolvedValue({ data: { summary: "No Id Here" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("google-calendar"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
  });

  it("zoom: reads email, display_name, and the account id", async () => {
    mockProxy.mockResolvedValue({
      data: { id: "zoom-uid-1", email: "z@zoom.us", display_name: "Zed" }
    });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: "z@zoom.us",
      displayName: "Zed",
      accountId: "zoom-uid-1"
    });
  });

  it("zoom: builds the display name from first/last when display_name is absent", async () => {
    mockProxy.mockResolvedValue({ data: { email: "z@zoom.us", first_name: "Zed", last_name: "Zoom" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: "z@zoom.us",
      displayName: "Zed Zoom",
      accountId: null
    });

    mockProxy.mockResolvedValue({ data: { email: "z@zoom.us", last_name: "Zoom" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: "z@zoom.us",
      displayName: "Zoom",
      accountId: null
    });

    mockProxy.mockResolvedValue({ data: { email: "z@zoom.us" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: "z@zoom.us",
      displayName: null,
      accountId: null
    });
  });

  it("zoom: nothing usable returns the null identity", async () => {
    mockProxy.mockResolvedValue({ data: {} });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
  });

  it("calendly: reads the nested resource", async () => {
    mockProxy.mockResolvedValue({
      data: { resource: { email: "c@calendly.com", name: "Cal" } }
    });
    await expect(fetchProviderAccountIdentity(BIZ, link("calendly"))).resolves.toEqual({
      email: "c@calendly.com",
      displayName: "Cal",
      accountId: null
    });
  });

  it("calendly: empty resource returns the null identity", async () => {
    mockProxy.mockResolvedValue({ data: { resource: {} } });
    await expect(fetchProviderAccountIdentity(BIZ, link("calendly"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
  });

  it("returns the null identity for unknown providers without calling the proxy", async () => {
    await expect(fetchProviderAccountIdentity(BIZ, link("slack"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("treats a null proxy result (unverified link) as a failed probe", async () => {
    mockProxy.mockResolvedValue(null);
    await expect(fetchProviderAccountIdentity(BIZ, link("gmail"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
  });

  it("swallows probe errors and returns the null identity", async () => {
    mockProxy.mockRejectedValue(new Error("provider down"));
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
  });

  it("handles non-object payloads", async () => {
    mockProxy.mockResolvedValue({ data: "not json" });
    await expect(fetchProviderAccountIdentity(BIZ, link("gmail"))).resolves.toEqual({
      email: null,
      displayName: null,
      accountId: null
    });
  });
});

describe("nangoIdentityPatchBody", () => {
  it("builds end_user + tags from a full identity", () => {
    expect(
      nangoIdentityPatchBody("biz-1", { email: "a@b.co", displayName: "A", accountId: null })
    ).toEqual({
      end_user: { id: "biz-1", email: "a@b.co", display_name: "A" },
      tags: {
        end_user_id: "biz-1",
        end_user_email: "a@b.co",
        end_user_display_name: "A"
      }
    });
  });

  it("falls back to the email as display name when the probe has none", () => {
    expect(
      nangoIdentityPatchBody("biz-1", { email: "a@b.co", displayName: null, accountId: null })
    ).toEqual({
      end_user: { id: "biz-1", email: "a@b.co", display_name: "a@b.co" },
      tags: {
        end_user_id: "biz-1",
        end_user_email: "a@b.co",
        end_user_display_name: "a@b.co"
      }
    });
  });

  it("omits the email tag when only a display name resolved", () => {
    expect(
      nangoIdentityPatchBody("biz-1", { email: null, displayName: "Owner", accountId: null })
    ).toEqual({
      end_user: { id: "biz-1", display_name: "Owner" },
      tags: { end_user_id: "biz-1", end_user_display_name: "Owner" }
    });
  });

  it("returns null for the null identity (leave Nango untouched)", () => {
    expect(
      nangoIdentityPatchBody("biz-1", { email: null, displayName: null, accountId: null })
    ).toBeNull();
  });
});

describe("providerAccountMetadata", () => {
  it("emits only the keys that were resolved", () => {
    expect(providerAccountMetadata({ email: "a@b.co", displayName: "A", accountId: null })).toEqual({
      provider_account_email: "a@b.co",
      provider_account_display_name: "A"
    });
    expect(providerAccountMetadata({ email: "a@b.co", displayName: null, accountId: null })).toEqual({
      provider_account_email: "a@b.co"
    });
    expect(providerAccountMetadata({ email: null, displayName: "A", accountId: null })).toEqual({
      provider_account_display_name: "A"
    });
    expect(providerAccountMetadata({ email: null, displayName: null, accountId: null })).toEqual({});
  });

  it("stores the account id under the key the reconnect matcher reads", () => {
    // provider_account_id is what findReconnectTarget's veto compares, so a
    // probe-labeled row (nango complete, the backfill script) must write it
    // whenever the probe resolved one.
    expect(
      providerAccountMetadata({ email: "a@b.co", displayName: null, accountId: "graph-1" })
    ).toEqual({
      provider_account_email: "a@b.co",
      provider_account_id: "graph-1"
    });
  });
});

/**
 * The transport-agnostic probe.
 *
 * `fetchProviderAccountIdentity` goes through the Nango transport specifically,
 * so once Google was deleted from Nango (2026-08-13) it could only ever fail for
 * a Google row. That is reachable: an unlabeled row takes the reconnect verify
 * branch, and a failed probe resolves to "new", so the owner gets a duplicate
 * row instead of their existing one being adopted.
 */
describe("fetchWorkspaceAccountIdentity", () => {
  beforeEach(() => {
    mockProxy.mockReset();
    mockWorkspaceProxy.mockReset();
  });

  it("probes through the seam, so a DIRECT row resolves", async () => {
    mockWorkspaceProxy.mockResolvedValue({
      status: 200,
      data: { emailAddress: "owner@acme.com" }
    });

    const identity = await fetchWorkspaceAccountIdentity(BIZ, {
      connectionId: "direct:abc",
      providerConfigKey: "google"
    });

    expect(identity.email).toBe("owner@acme.com");
    // The Nango transport must not be consulted: it cannot serve a direct row,
    // and reaching for it is the bug this function exists to fix.
    expect(mockProxy).not.toHaveBeenCalled();
    const [businessId, link, config] = mockWorkspaceProxy.mock.calls[0] as [
      string,
      { connectionId: string },
      { endpoint: string; method: string }
    ];
    expect(businessId).toBe(BIZ);
    expect(link.connectionId).toBe("direct:abc");
    expect(config.method).toBe("GET");
  });

  it("still resolves a Nango row, since the seam dispatches on the row", async () => {
    mockWorkspaceProxy.mockResolvedValue({
      status: 200,
      data: { emailAddress: "legacy@acme.com" }
    });
    const identity = await fetchWorkspaceAccountIdentity(BIZ, link("google"));
    expect(identity.email).toBe("legacy@acme.com");
  });

  it("returns nulls when every probe fails, rather than throwing", async () => {
    // A dead grant is often exactly WHY someone is reconnecting, so the caller
    // has to be able to treat "cannot tell" as an answer.
    mockWorkspaceProxy.mockResolvedValue(null);
    const identity = await fetchWorkspaceAccountIdentity(BIZ, link("google"));
    expect(identity.email).toBeNull();
  });
});
