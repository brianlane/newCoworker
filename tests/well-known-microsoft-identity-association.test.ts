/**
 * The Entra publisher-domain proof.
 *
 * Entra fetches this exact URL and looks for the application id. The shape is
 * not ours to choose, and a wrong one fails a verification that gates whether
 * ordinary users at customer orgs can consent at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/.well-known/microsoft-identity-association.json/route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe(".well-known/microsoft-identity-association.json", () => {
  it("serves the exact shape Entra expects, with the app id", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "a3e093b9-2546-4da2-8376-92ecd6d21fbd");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      associatedApplications: [{ applicationId: "a3e093b9-2546-4da2-8376-92ecd6d21fbd" }]
    });
  });

  it("404s when Outlook is not configured on this deploy", () => {
    // Rather than an empty associatedApplications array, which Entra would
    // fetch happily and then reject as a failed proof.
    vi.stubEnv("MICROSOFT_CLIENT_ID", undefined);
    expect(GET().status).toBe(404);
  });

  it("is not cached, so rotating the id takes effect without a redeploy", () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "abc");
    expect(GET().headers.get("cache-control")).toBe("no-store");
  });
});
