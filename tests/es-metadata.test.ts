import { beforeEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => headersMock()
}));

import { esAlternatesForRequest } from "@/lib/i18n/es-metadata";

describe("esAlternatesForRequest", () => {
  beforeEach(() => {
    headersMock.mockReset();
  });

  it("self-canonicals a Spanish /es URL from x-pathname, ignoring cookies", async () => {
    headersMock.mockResolvedValue({
      get: (name: string) => (name === "x-pathname" ? "/es/pricing" : null)
    });
    await expect(esAlternatesForRequest("/pricing")).resolves.toMatchObject({
      canonical: "/es/pricing",
      languages: {
        en: "/pricing",
        es: "/es/pricing",
        "x-default": "/pricing"
      }
    });
  });

  it("keeps the English URL canonical when x-pathname is unprefixed", async () => {
    headersMock.mockResolvedValue({
      get: (name: string) => (name === "x-pathname" ? "/pricing" : null)
    });
    await expect(esAlternatesForRequest("/pricing")).resolves.toMatchObject({
      canonical: "/pricing"
    });
  });

  it("defaults to English when x-pathname is missing (build, non-proxy)", async () => {
    headersMock.mockResolvedValue({ get: () => null });
    await expect(esAlternatesForRequest("/")).resolves.toMatchObject({
      canonical: "/"
    });
  });

  it("strips a query string on x-pathname before classifying", async () => {
    headersMock.mockResolvedValue({
      get: (name: string) =>
        name === "x-pathname" ? "/es/blog?category=product" : null
    });
    await expect(esAlternatesForRequest("/blog")).resolves.toMatchObject({
      canonical: "/es/blog"
    });
  });
});
