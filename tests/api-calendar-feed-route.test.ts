/**
 * The public feed route and the owner surface for its URL.
 *
 * The public route's fail-closed shape check matters: a malformed token must
 * cost neither a DB read nor a rate-limit slot, and every miss is the same
 * 404 so a probe cannot distinguish garbage from a rotated token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/calendar-feed", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/calendar-feed")>(
    "@/lib/db/calendar-feed"
  );
  return {
    ...actual,
    findBusinessByCalendarFeedToken: vi.fn(),
    ensureCalendarFeedToken: vi.fn(),
    rotateCalendarFeedToken: vi.fn()
  };
});
vi.mock("@/lib/calendar-tools/feed", () => ({ renderCalendarFeed: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitDurable: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));

import { GET as feedGET } from "@/app/api/calendar/[token]/route";
import {
  GET as dashGET,
  POST as dashPOST
} from "@/app/api/dashboard/calendar-feed/route";
import {
  ensureCalendarFeedToken,
  findBusinessByCalendarFeedToken,
  rotateCalendarFeedToken
} from "@/lib/db/calendar-feed";
import { renderCalendarFeed } from "@/lib/calendar-tools/feed";
import { rateLimitDurable } from "@/lib/rate-limit";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TOKEN = `ncbf_${"a".repeat(64)}`;
const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

function feedReq(token: string) {
  return [
    new Request(`https://app.example.com/api/calendar/${token}`),
    { params: Promise.resolve({ token }) }
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimitDurable).mockResolvedValue({ success: true } as never);
  vi.mocked(findBusinessByCalendarFeedToken).mockResolvedValue(BIZ);
  vi.mocked(renderCalendarFeed).mockResolvedValue(ICS);
  vi.mocked(getAuthUser).mockResolvedValue({ email: "o@x.co", isAdmin: false } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(ensureCalendarFeedToken).mockResolvedValue(TOKEN);
  vi.mocked(rotateCalendarFeedToken).mockResolvedValue(`ncbf_${"b".repeat(64)}`);
});

describe("GET /api/calendar/[token]", () => {
  it("serves the calendar with the right content type", async () => {
    const res = await feedGET(...feedReq(`${TOKEN}.ics`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    expect(await res.text()).toBe(ICS);
  });

  it("404s a malformed token with NO db read and NO rate-limit slot", async () => {
    const res = await feedGET(...feedReq("not-a-token"));
    expect(res.status).toBe(404);
    expect(vi.mocked(rateLimitDurable)).not.toHaveBeenCalled();
    expect(vi.mocked(findBusinessByCalendarFeedToken)).not.toHaveBeenCalled();
  });

  it("404s a rotated (unknown) token indistinguishably", async () => {
    vi.mocked(findBusinessByCalendarFeedToken).mockResolvedValue(null);
    const res = await feedGET(...feedReq(TOKEN));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("404s when the business vanished after the token resolved", async () => {
    vi.mocked(renderCalendarFeed).mockResolvedValue(null);
    const res = await feedGET(...feedReq(TOKEN));
    expect(res.status).toBe(404);
  });

  it("429s when the durable limiter says stop", async () => {
    // Durable on purpose: subscribers poll from Google's and Apple's fetch
    // fleets, so a per-isolate limiter would barely bind.
    vi.mocked(rateLimitDurable).mockResolvedValue({ success: false } as never);
    const res = await feedGET(...feedReq(TOKEN));
    expect(res.status).toBe(429);
    expect(vi.mocked(findBusinessByCalendarFeedToken)).not.toHaveBeenCalled();
  });

  it("hands unexpected failures to the shared route handler", async () => {
    vi.mocked(renderCalendarFeed).mockRejectedValue(new Error("boom"));
    const res = await feedGET(...feedReq(TOKEN));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("dashboard calendar-feed surface", () => {
  it("mints on first ask and returns a .ics URL", async () => {
    const res = await dashGET(
      new Request(`https://app.example.com/api/dashboard/calendar-feed?businessId=${BIZ}`)
    );
    const json = (await res.json()) as { data?: { feedUrl?: string } };
    expect(json.data?.feedUrl).toBe(`https://app.example.com/api/calendar/${TOKEN}.ics`);
  });

  it("requires a businessId and an authenticated caller", async () => {
    const bad = await dashGET(new Request("https://app.example.com/api/dashboard/calendar-feed"));
    expect(bad.status).not.toBe(200);
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const anon = await dashGET(
      new Request(`https://app.example.com/api/dashboard/calendar-feed?businessId=${BIZ}`)
    );
    expect(anon.status).toBe(401);
  });

  it("requires manage_settings for a non-admin and lets an admin bypass", async () => {
    await dashGET(
      new Request(`https://app.example.com/api/dashboard/calendar-feed?businessId=${BIZ}`)
    );
    expect(vi.mocked(requireBusinessRole)).toHaveBeenCalledWith(BIZ, "manage_settings");
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({ email: "a@x.co", isAdmin: true } as never);
    vi.mocked(ensureCalendarFeedToken).mockResolvedValue(TOKEN);
    await dashGET(
      new Request(`https://app.example.com/api/dashboard/calendar-feed?businessId=${BIZ}`)
    );
    expect(vi.mocked(requireBusinessRole)).not.toHaveBeenCalled();
  });

  it("rotates, returning the NEW url", async () => {
    const res = await dashPOST(
      new Request("https://app.example.com/api/dashboard/calendar-feed", {
        method: "POST",
        body: JSON.stringify({ businessId: BIZ })
      })
    );
    const json = (await res.json()) as { data?: { feedUrl?: string; rotated?: boolean } };
    expect(json.data?.rotated).toBe(true);
    expect(json.data?.feedUrl).toContain("b".repeat(64));
  });

  it("refuses an unauthenticated rotate", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await dashPOST(
      new Request("https://app.example.com/api/dashboard/calendar-feed", {
        method: "POST",
        body: JSON.stringify({ businessId: BIZ })
      })
    );
    expect(res.status).toBe(401);
    expect(vi.mocked(rotateCalendarFeedToken)).not.toHaveBeenCalled();
  });
});
