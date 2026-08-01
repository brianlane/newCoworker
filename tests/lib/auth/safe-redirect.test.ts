import { describe, it, expect } from "vitest";
import { safeInternalPath } from "@/lib/auth/safe-redirect";

describe("safeInternalPath", () => {
  it("returns an app-relative path unchanged, keeping query and hash", () => {
    expect(safeInternalPath("/dashboard/settings?tab=team#top", "/dashboard")).toBe(
      "/dashboard/settings?tab=team#top"
    );
    expect(safeInternalPath("/", "/dashboard")).toBe("/");
  });

  it("falls back when no candidate is provided", () => {
    expect(safeInternalPath(null, "/dashboard")).toBe("/dashboard");
    expect(safeInternalPath(undefined, "/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("", "/dashboard")).toBe("/dashboard");
  });

  it("rejects absolute URLs", () => {
    expect(safeInternalPath("https://evil.example/phish", "/dashboard")).toBe("/dashboard");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeInternalPath("//evil.example", "/dashboard")).toBe("/dashboard");
  });

  it("rejects backslash paths that URL parsing reads as protocol-relative", () => {
    expect(safeInternalPath("/\\evil.example", "/dashboard")).toBe("/dashboard");
  });

  it("falls back when the candidate does not parse as a URL", () => {
    // Backslash promotes "evil host" to an authority, whose space then makes
    // the whole value unparseable.
    expect(safeInternalPath("/\\evil host", "/dashboard")).toBe("/dashboard");
  });
});
