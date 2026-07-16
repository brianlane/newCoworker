import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxy = vi.fn();

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: (...a: unknown[]) => mockProxy(...a)
}));

import {
  fetchProviderAccountIdentity,
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
      displayName: null
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
      displayName: "Real Name"
    });
    expect(mockProxy).toHaveBeenCalledTimes(2);
  });

  it("broad google: skips a probe whose payload has nothing usable", async () => {
    mockProxy
      .mockResolvedValueOnce({ data: { historyId: "123" } })
      .mockResolvedValueOnce({ data: { id: "real@gmail.com" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("google"))).resolves.toEqual({
      email: "real@gmail.com",
      displayName: null
    });
  });

  it("microsoft: uses mail, falling back to userPrincipalName", async () => {
    mockProxy.mockResolvedValue({
      data: { mail: "owner@contoso.com", userPrincipalName: "upn@contoso.com", displayName: "Owner" }
    });
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook"))).resolves.toEqual({
      email: "owner@contoso.com",
      displayName: "Owner"
    });

    mockProxy.mockResolvedValue({
      data: { mail: null, userPrincipalName: "upn@contoso.com" }
    });
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook-calendar"))).resolves.toEqual({
      email: "upn@contoso.com",
      displayName: null
    });
  });

  it("microsoft: display name alone still identifies the account", async () => {
    mockProxy.mockResolvedValue({ data: { displayName: "Owner Only" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("onedrive"))).resolves.toEqual({
      email: null,
      displayName: "Owner Only"
    });
  });

  it("microsoft: an empty Graph payload returns the null identity", async () => {
    mockProxy.mockResolvedValue({ data: {} });
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook"))).resolves.toEqual({
      email: null,
      displayName: null
    });
  });

  it("google-calendar: a payload without an id returns the null identity", async () => {
    mockProxy.mockResolvedValue({ data: { summary: "No Id Here" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("google-calendar"))).resolves.toEqual({
      email: null,
      displayName: null
    });
  });

  it("zoom: reads email and display_name", async () => {
    mockProxy.mockResolvedValue({
      data: { email: "z@zoom.us", display_name: "Zed" }
    });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: "z@zoom.us",
      displayName: "Zed"
    });
  });

  it("zoom: builds the display name from first/last when display_name is absent", async () => {
    mockProxy.mockResolvedValue({ data: { email: "z@zoom.us", first_name: "Zed", last_name: "Zoom" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: "z@zoom.us",
      displayName: "Zed Zoom"
    });

    mockProxy.mockResolvedValue({ data: { email: "z@zoom.us", last_name: "Zoom" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: "z@zoom.us",
      displayName: "Zoom"
    });

    mockProxy.mockResolvedValue({ data: { email: "z@zoom.us" } });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: "z@zoom.us",
      displayName: null
    });
  });

  it("zoom: nothing usable returns the null identity", async () => {
    mockProxy.mockResolvedValue({ data: {} });
    await expect(fetchProviderAccountIdentity(BIZ, link("zoom"))).resolves.toEqual({
      email: null,
      displayName: null
    });
  });

  it("calendly: reads the nested resource", async () => {
    mockProxy.mockResolvedValue({
      data: { resource: { email: "c@calendly.com", name: "Cal" } }
    });
    await expect(fetchProviderAccountIdentity(BIZ, link("calendly"))).resolves.toEqual({
      email: "c@calendly.com",
      displayName: "Cal"
    });
  });

  it("calendly: empty resource returns the null identity", async () => {
    mockProxy.mockResolvedValue({ data: { resource: {} } });
    await expect(fetchProviderAccountIdentity(BIZ, link("calendly"))).resolves.toEqual({
      email: null,
      displayName: null
    });
  });

  it("returns the null identity for unknown providers without calling the proxy", async () => {
    await expect(fetchProviderAccountIdentity(BIZ, link("slack"))).resolves.toEqual({
      email: null,
      displayName: null
    });
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("treats a null proxy result (unverified link) as a failed probe", async () => {
    mockProxy.mockResolvedValue(null);
    await expect(fetchProviderAccountIdentity(BIZ, link("gmail"))).resolves.toEqual({
      email: null,
      displayName: null
    });
  });

  it("swallows probe errors and returns the null identity", async () => {
    mockProxy.mockRejectedValue(new Error("provider down"));
    await expect(fetchProviderAccountIdentity(BIZ, link("outlook"))).resolves.toEqual({
      email: null,
      displayName: null
    });
  });

  it("handles non-object payloads", async () => {
    mockProxy.mockResolvedValue({ data: "not json" });
    await expect(fetchProviderAccountIdentity(BIZ, link("gmail"))).resolves.toEqual({
      email: null,
      displayName: null
    });
  });
});

describe("nangoIdentityPatchBody", () => {
  it("builds end_user + tags from a full identity", () => {
    expect(nangoIdentityPatchBody("biz-1", { email: "a@b.co", displayName: "A" })).toEqual({
      end_user: { id: "biz-1", email: "a@b.co", display_name: "A" },
      tags: {
        end_user_id: "biz-1",
        end_user_email: "a@b.co",
        end_user_display_name: "A"
      }
    });
  });

  it("falls back to the email as display name when the probe has none", () => {
    expect(nangoIdentityPatchBody("biz-1", { email: "a@b.co", displayName: null })).toEqual({
      end_user: { id: "biz-1", email: "a@b.co", display_name: "a@b.co" },
      tags: {
        end_user_id: "biz-1",
        end_user_email: "a@b.co",
        end_user_display_name: "a@b.co"
      }
    });
  });

  it("omits the email tag when only a display name resolved", () => {
    expect(nangoIdentityPatchBody("biz-1", { email: null, displayName: "Owner" })).toEqual({
      end_user: { id: "biz-1", display_name: "Owner" },
      tags: { end_user_id: "biz-1", end_user_display_name: "Owner" }
    });
  });

  it("returns null for the null identity (leave Nango untouched)", () => {
    expect(nangoIdentityPatchBody("biz-1", { email: null, displayName: null })).toBeNull();
  });
});

describe("providerAccountMetadata", () => {
  it("emits only the keys that were resolved", () => {
    expect(providerAccountMetadata({ email: "a@b.co", displayName: "A" })).toEqual({
      provider_account_email: "a@b.co",
      provider_account_display_name: "A"
    });
    expect(providerAccountMetadata({ email: "a@b.co", displayName: null })).toEqual({
      provider_account_email: "a@b.co"
    });
    expect(providerAccountMetadata({ email: null, displayName: "A" })).toEqual({
      provider_account_display_name: "A"
    });
    expect(providerAccountMetadata({ email: null, displayName: null })).toEqual({});
  });
});
