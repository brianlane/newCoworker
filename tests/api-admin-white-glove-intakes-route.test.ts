import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/white-glove/intake", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/white-glove/intake")>();
  return {
    ...actual,
    createWhiteGloveIntake: vi.fn(),
    listWhiteGloveIntakes: vi.fn(),
    revokeWhiteGloveIntake: vi.fn()
  };
});

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn().mockResolvedValue("email_1")
}));

import { POST, GET, DELETE } from "@/app/api/admin/white-glove-intakes/route";
import { requireAdmin } from "@/lib/auth";
import {
  createWhiteGloveIntake,
  listWhiteGloveIntakes,
  revokeWhiteGloveIntake
} from "@/lib/white-glove/intake";
import { sendOwnerEmail } from "@/lib/email/client";

const INTAKE_ID = "33333333-3333-4333-8333-333333333333";
const BIZ_ID = "11111111-1111-4111-8111-111111111111";

const INTAKE = {
  id: INTAKE_ID,
  token: "tok-1",
  business_name: "Acme Home Services",
  industry: "home_services",
  recipient_email: "prospect@example.com",
  business_id: null,
  answers: null,
  status: "sent",
  created_by: "admin@example.com",
  created_at: "2026-07-01T00:00:00Z",
  completed_at: null
};

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/api/admin/white-glove-intakes", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/white-glove-intakes route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(createWhiteGloveIntake).mockResolvedValue(INTAKE as never);
  });

  it("POST creates an intake from a business name + email with the admin as author", async () => {
    const res = await POST(
      jsonRequest("POST", {
        businessName: "Acme Home Services",
        industry: "home_services",
        recipientEmail: "prospect@example.com"
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(createWhiteGloveIntake).toHaveBeenCalledWith({
      businessName: "Acme Home Services",
      industry: "home_services",
      recipientEmail: "prospect@example.com",
      businessId: null,
      createdBy: "admin@example.com"
    });
    expect(body.data.intakeUrl).toContain("/intake/tok-1");
  });

  it("POST works with just a business name (no email) — link only, nothing emailed", async () => {
    process.env.RESEND_API_KEY = "resend_test";
    try {
      vi.mocked(createWhiteGloveIntake).mockResolvedValue({
        ...INTAKE,
        recipient_email: null
      } as never);
      const res = await POST(jsonRequest("POST", { businessName: "Solo Law" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      // Industry defaults to the generic preset.
      expect(createWhiteGloveIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          businessName: "Solo Law",
          industry: "other",
          recipientEmail: null
        })
      );
      expect(body.data.emailedTo).toBeNull();
      expect(body.data.intakeUrl).toContain("/intake/tok-1");
      expect(sendOwnerEmail).not.toHaveBeenCalled();
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });

  it("POST can tie the intake to an existing business", async () => {
    const res = await POST(
      jsonRequest("POST", {
        businessName: "Corp",
        recipientEmail: "owner@example.com",
        businessId: BIZ_ID
      })
    );
    expect(res.status).toBe(200);
    expect(createWhiteGloveIntake).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ_ID })
    );
  });

  it("POST emails the questionnaire link and reports emailedTo", async () => {
    process.env.RESEND_API_KEY = "resend_test";
    try {
      const res = await POST(
        jsonRequest("POST", {
          businessName: "Acme Home Services",
          recipientEmail: "prospect@example.com"
        })
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.emailedTo).toBe("prospect@example.com");
      expect(sendOwnerEmail).toHaveBeenCalledWith(
        "resend_test",
        "prospect@example.com",
        expect.stringContaining("questionnaire"),
        expect.objectContaining({ text: expect.stringContaining("/intake/tok-1") })
      );
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });

  it("POST still succeeds (emailedTo null) when the key is unset or the send fails", async () => {
    delete process.env.RESEND_API_KEY;
    const noKey = await POST(
      jsonRequest("POST", { businessName: "Acme", recipientEmail: "p@x.com" })
    );
    expect((await noKey.json()).data.emailedTo).toBeNull();

    process.env.RESEND_API_KEY = "resend_test";
    try {
      vi.mocked(sendOwnerEmail).mockRejectedValueOnce(new Error("resend down"));
      const failed = await POST(
        jsonRequest("POST", { businessName: "Acme", recipientEmail: "p@x.com" })
      );
      const body = await failed.json();
      expect(failed.status).toBe(200);
      expect(body.data.emailedTo).toBeNull();

      // Resend can also reject WITHOUT throwing (no message id): still null.
      vi.mocked(sendOwnerEmail).mockResolvedValueOnce(null);
      const rejected = await POST(
        jsonRequest("POST", { businessName: "Acme", recipientEmail: "p@x.com" })
      );
      expect((await rejected.json()).data.emailedTo).toBeNull();
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });

  it("POST falls back to the admin userId when the email is missing", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ userId: "admin-1", email: null } as never);
    const res = await POST(jsonRequest("POST", { businessName: "Acme" }));
    expect(res.status).toBe(200);
    expect(createWhiteGloveIntake).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: "admin-1" })
    );
  });

  it("POST 400s on a missing name, unknown industry, or invalid email/businessId", async () => {
    expect((await POST(jsonRequest("POST", {}))).status).toBe(400);
    expect((await POST(jsonRequest("POST", { businessName: "  " }))).status).toBe(400);
    expect(
      (await POST(jsonRequest("POST", { businessName: "Acme", industry: "nope" }))).status
    ).toBe(400);
    expect(
      (
        await POST(
          jsonRequest("POST", { businessName: "Acme", recipientEmail: "not-an-email" })
        )
      ).status
    ).toBe(400);
    expect(
      (await POST(jsonRequest("POST", { businessName: "Acme", businessId: "nope" }))).status
    ).toBe(400);
    expect(createWhiteGloveIntake).not.toHaveBeenCalled();
  });

  it("GET lists every intake with its public link", async () => {
    vi.mocked(listWhiteGloveIntakes).mockResolvedValue([INTAKE as never]);
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.intakes).toHaveLength(1);
    expect(body.data.intakes[0].intakeUrl).toContain("/intake/tok-1");
  });

  it("DELETE revokes a sent intake and 409s when it isn't open", async () => {
    vi.mocked(revokeWhiteGloveIntake).mockResolvedValue(true);
    const ok = await DELETE(jsonRequest("DELETE", { intakeId: INTAKE_ID }));
    expect(ok.status).toBe(200);

    vi.mocked(revokeWhiteGloveIntake).mockResolvedValue(false);
    const conflict = await DELETE(jsonRequest("DELETE", { intakeId: INTAKE_ID }));
    const body = await conflict.json();
    expect(conflict.status).toBe(409);
    expect(body.error.message).toContain("not open");
  });

  it("DELETE 400s on an invalid intakeId", async () => {
    expect((await DELETE(jsonRequest("DELETE", { intakeId: "nope" }))).status).toBe(400);
  });

  it("propagates admin auth failures", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Admin access required"));
    expect((await GET()).status).toBe(500);
  });
});
