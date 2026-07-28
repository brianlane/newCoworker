/**
 * The meeting-types dashboard endpoint: auth, the per-business scoping
 * every write carries, and the owner-facing shape of a refused write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => ({ success: true })) }));
vi.mock("@/lib/booking-page/meeting-types", () => ({
  listMeetingTypes: vi.fn(),
  createMeetingType: vi.fn(),
  updateMeetingType: vi.fn(),
  deleteMeetingType: vi.fn()
}));

import { DELETE, GET, PATCH, POST } from "@/app/api/dashboard/booking-page/meeting-types/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { BookingPageValidationError } from "@/lib/booking-page/db";
import {
  createMeetingType,
  deleteMeetingType,
  listMeetingTypes,
  updateMeetingType
} from "@/lib/booking-page/meeting-types";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TYPE_ID = "22222222-2222-4222-8222-222222222222";
const BASE = "http://localhost/api/dashboard/booking-page/meeting-types";

const mockUser = vi.mocked(getAuthUser);
const mockRole = vi.mocked(requireBusinessRole);
const mockLimit = vi.mocked(rateLimit);
const mockList = vi.mocked(listMeetingTypes);
const mockCreate = vi.mocked(createMeetingType);
const mockUpdate = vi.mocked(updateMeetingType);
const mockDelete = vi.mocked(deleteMeetingType);

function req(path: string, init?: RequestInit): Request {
  return new Request(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.mockResolvedValue({ id: "u-1", isAdmin: false } as never);
  mockRole.mockResolvedValue(undefined as never);
  mockLimit.mockReturnValue({ success: true } as never);
  mockList.mockResolvedValue([]);
  mockCreate.mockResolvedValue({ id: TYPE_ID } as never);
  mockUpdate.mockResolvedValue({ id: TYPE_ID } as never);
  mockDelete.mockResolvedValue(undefined);
});

describe("GET", () => {
  it("lists the business's types for an owner with settings rights", async () => {
    const res = await GET(req(`?businessId=${BIZ}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { meetingTypes: [] } });
    expect(mockRole).toHaveBeenCalledWith(BIZ, "manage_settings");
  });

  it("refuses an anonymous caller and rate-limits a hot loop", async () => {
    mockUser.mockResolvedValue(null as never);
    expect((await GET(req(`?businessId=${BIZ}`))).status).toBe(401);

    mockUser.mockResolvedValue({ id: "u-1", isAdmin: false } as never);
    mockLimit.mockReturnValue({ success: false } as never);
    expect((await GET(req(`?businessId=${BIZ}`))).status).toBe(429);
  });

  it("admins skip the ownership check (the dashboard convention)", async () => {
    mockUser.mockResolvedValue({ id: "admin", isAdmin: true } as never);
    expect((await GET(req(`?businessId=${BIZ}`))).status).toBe(200);
    expect(mockRole).not.toHaveBeenCalled();
  });

  it("rejects a malformed businessId", async () => {
    expect((await GET(req("?businessId=nope"))).status).toBe(400);
  });
});

describe("POST", () => {
  it("creates from the submitted fields", async () => {
    const res = await POST(
      req(`?businessId=${BIZ}`, {
        method: "POST",
        body: JSON.stringify({ name: "Discovery", slug: "discovery", durationMinutes: 60 })
      })
    );
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(BIZ, {
      name: "Discovery",
      slug: "discovery",
      durationMinutes: 60
    });
  });

  it("turns a validation refusal into the owner-facing message", async () => {
    mockCreate.mockRejectedValue(new BookingPageValidationError("That meeting link is already taken"));
    const res = await POST(
      req(`?businessId=${BIZ}`, {
        method: "POST",
        body: JSON.stringify({ name: "Discovery", slug: "discovery", durationMinutes: 60 })
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { message: "That meeting link is already taken" }
    });

    // Anything else stays a generic failure.
    mockCreate.mockRejectedValue(new Error("connection reset"));
    expect(
      (
        await POST(
          req(`?businessId=${BIZ}`, {
            method: "POST",
            body: JSON.stringify({ name: "D", slug: "d-x", durationMinutes: 60 })
          })
        )
      ).status
    ).toBe(500);
  });

  it("rate-limits writes", async () => {
    mockLimit.mockReturnValue({ success: false } as never);
    expect(
      (await POST(req(`?businessId=${BIZ}`, { method: "POST", body: "{}" }))).status
    ).toBe(429);
  });
});

describe("PATCH", () => {
  it("edits the named type, scoped to the business", async () => {
    const res = await PATCH(
      req(`?businessId=${BIZ}&id=${TYPE_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true, intakeQuestions: null })
      })
    );
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(BIZ, TYPE_ID, {
      hidden: true,
      // Null is meaningful: it restores inheritance of the page's questions.
      intakeQuestions: null
    });
  });

  it("needs a type id, surfaces validation, and rate-limits", async () => {
    // No id in the query is a malformed request, not a server fault.
    expect(
      (await PATCH(req(`?businessId=${BIZ}`, { method: "PATCH", body: "{}" }))).status
    ).toBe(400);

    mockUpdate.mockRejectedValue(new BookingPageValidationError("Set a price to require payment"));
    const refused = await PATCH(
      req(`?businessId=${BIZ}&id=${TYPE_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ paymentRequired: true })
      })
    );
    expect(refused.status).toBe(400);

    mockUpdate.mockRejectedValue(new Error("boom"));
    expect(
      (
        await PATCH(
          req(`?businessId=${BIZ}&id=${TYPE_ID}`, { method: "PATCH", body: "{}" })
        )
      ).status
    ).toBe(500);

    mockLimit.mockReturnValue({ success: false } as never);
    expect(
      (
        await PATCH(
          req(`?businessId=${BIZ}&id=${TYPE_ID}`, { method: "PATCH", body: "{}" })
        )
      ).status
    ).toBe(429);
  });
});

describe("DELETE", () => {
  it("removes the named type, and rate-limits", async () => {
    const res = await DELETE(
      req(`?businessId=${BIZ}&id=${TYPE_ID}`, { method: "DELETE" })
    );
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith(BIZ, TYPE_ID);

    mockLimit.mockReturnValue({ success: false } as never);
    expect(
      (await DELETE(req(`?businessId=${BIZ}&id=${TYPE_ID}`, { method: "DELETE" }))).status
    ).toBe(429);
  });
});
