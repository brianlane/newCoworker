/**
 * The Calendly reconnect banner formats last-check in the browser timezone
 * after hydration, never during SSR. Production Node is UTC, so formatting
 * on first render would disagree with the owner's local clock and trip a
 * hydration mismatch on every dashboard page.
 *
 * Source-level, matching LocalDateTime / calls-list: the banner is a client
 * component rendered from the dashboard layout, cheaper to verify by reading
 * it than by standing up a render harness.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BANNER = readFileSync(
  join(ROOT, "src/components/dashboard/CalendlyReauthBanner.tsx"),
  "utf8"
);

describe("CalendlyReauthBanner last-check hydration", () => {
  it("formats last-check via useSyncExternalStore, UTC until hydrated", () => {
    expect(BANNER).toContain("useSyncExternalStore");
    expect(BANNER).toContain('hydrated ? undefined : "UTC"');
    expect(BANNER).toContain("suppressHydrationWarning");
    expect(BANNER).toContain("lastHealthyAt");
    expect(BANNER).not.toContain("lastHealthyLabel:");
  });
});
