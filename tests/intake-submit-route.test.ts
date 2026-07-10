import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/white-glove/intake", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/white-glove/intake")>();
  return { ...actual, submitWhiteGloveIntake: vi.fn() };
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimitDurable: vi.fn().mockResolvedValue({ success: true }),
  rateLimitIdentifierFromRequest: vi.fn().mockReturnValue("ip:1.2.3.4")
}));

import { POST } from "@/app/intake/[token]/submit/route";
import { submitWhiteGloveIntake } from "@/lib/white-glove/intake";
import { rateLimitDurable } from "@/lib/rate-limit";

const TOKEN = "0f0f0f0f-0000-4000-8000-0000000000aa";

const VALID_ANSWERS = {
  business_name: "Acme Home Services",
  industry: "home_services",
  business_hours: "Mon–Fri 9am–5pm",
  team: "Jane Smith — 555-123-4567",
  lead_sources: ["website_form"],
  tone: "friendly",
  appointment_length: "30",
  appointment_buffer: "none",
  booking_notice: "2h",
  booking_window: "30d",
  first_follow_up: "2h",
  second_follow_up: "next_day",
  handoff_after: "3_attempts",
  consent_confirmed: "yes"
};

function submitRequest(body: unknown): Request {
  return new Request(`http://localhost/intake/${TOKEN}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function routeParams(token: string) {
  return { params: Promise.resolve({ token }) };
}

describe("POST /intake/[token]/submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimitDurable).mockResolvedValue({ success: true } as never);
    vi.mocked(submitWhiteGloveIntake).mockResolvedValue(true);
  });

  it("validates + stores the answers against the token", async () => {
    const res = await POST(submitRequest(VALID_ANSWERS), routeParams(TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Optional fields are defaulted by the schema before storage.
    expect(submitWhiteGloveIntake).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({
        business_name: "Acme Home Services",
        greeting: "",
        never_handle: []
      })
    );
  });

  it("404s malformed tokens without touching the DB", async () => {
    const res = await POST(submitRequest(VALID_ANSWERS), routeParams("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(submitWhiteGloveIntake).not.toHaveBeenCalled();
  });

  it("429s when the IP rate limit trips", async () => {
    vi.mocked(rateLimitDurable).mockResolvedValue({ success: false } as never);
    const res = await POST(submitRequest(VALID_ANSWERS), routeParams(TOKEN));
    expect(res.status).toBe(429);
    expect(submitWhiteGloveIntake).not.toHaveBeenCalled();
  });

  it("400s malformed JSON and schema-invalid answers (with the failing field named)", async () => {
    const badJson = await POST(submitRequest("{nope"), routeParams(TOKEN));
    expect(badJson.status).toBe(400);

    const invalid = await POST(
      submitRequest({ ...VALID_ANSWERS, industry: "unknown" }),
      routeParams(TOKEN)
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toContain("industry");
    expect(submitWhiteGloveIntake).not.toHaveBeenCalled();
  });

  it("409s when the intake is unknown, completed, or revoked (one answer for all three)", async () => {
    vi.mocked(submitWhiteGloveIntake).mockResolvedValue(false);
    const res = await POST(submitRequest(VALID_ANSWERS), routeParams(TOKEN));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no longer open");
  });

  it("500s (without leaking details) when the store fails", async () => {
    vi.mocked(submitWhiteGloveIntake).mockRejectedValue(new Error("db down"));
    const res = await POST(submitRequest(VALID_ANSWERS), routeParams(TOKEN));
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain("db down");
  });
});
