import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireBusinessRole: vi.fn(),
  getAuthUser: vi.fn(),
  authUserExistsByEmail: vi.fn()
}));

vi.mock("@/lib/admin/view-as", () => ({
  isViewAsActive: vi.fn()
}));

vi.mock("@/lib/db/business-members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/business-members")>();
  return {
    ...actual,
    listBusinessMembers: vi.fn(),
    inviteBusinessMember: vi.fn(),
    updateBusinessMemberRole: vi.fn(),
    revokeBusinessMember: vi.fn()
  };
});

vi.mock("@/lib/team/tier-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/team/tier-gate")>();
  return {
    ...actual,
    assertTeamAccessAllowed: vi.fn()
  };
});

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

const { mockInviteUserByEmail } = vi.hoisted(() => ({
  mockInviteUserByEmail: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockResolvedValue({
    auth: { admin: { inviteUserByEmail: mockInviteUserByEmail } }
  })
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { GET, POST, PATCH, DELETE } from "@/app/api/dashboard/team/route";
import { requireBusinessRole, getAuthUser, authUserExistsByEmail } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import {
  listBusinessMembers,
  inviteBusinessMember,
  updateBusinessMemberRole,
  revokeBusinessMember,
  BusinessMemberConflictError
} from "@/lib/db/business-members";
import { assertTeamAccessAllowed, TeamAccessValidationError, TEAM_ACCESS_TIER_MESSAGE } from "@/lib/team/tier-gate";
import { getBusiness } from "@/lib/db/businesses";
import { sendOwnerEmail } from "@/lib/email/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

const MEMBER = {
  id: MEMBER_ID,
  business_id: BIZ,
  email: "staffer@example.com",
  user_id: null,
  role: "staff",
  status: "invited",
  invited_by: "owner@example.com",
  employee_id: null,
  created_at: "2026-07-08T00:00:00Z",
  accepted_at: null,
  revoked_at: null
};

function jsonRequest(method: string, body: unknown) {
  return new Request("http://localhost/api/dashboard/team", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/dashboard/team route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireBusinessRole).mockResolvedValue({
      userId: "owner-1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "owner-1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(isViewAsActive).mockResolvedValue(false);
    vi.mocked(assertTeamAccessAllowed).mockResolvedValue(undefined);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Corp",
      owner_email: "owner@example.com",
      tier: "enterprise"
    } as never);
    process.env.RESEND_API_KEY = "re_test";
  });

  it("GET lists the roster behind manage_team", async () => {
    vi.mocked(listBusinessMembers).mockResolvedValue([MEMBER] as never);
    const res = await GET(new Request(`http://localhost/api/dashboard/team?businessId=${BIZ}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.members).toEqual([MEMBER]);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_team");
  });

  it("GET rejects a malformed businessId", async () => {
    const res = await GET(new Request("http://localhost/api/dashboard/team?businessId=nope"));
    expect(res.status).toBe(400);
    expect(listBusinessMembers).not.toHaveBeenCalled();
  });

  it("POST invites a brand-new address via the Supabase auth invite", async () => {
    vi.mocked(inviteBusinessMember).mockResolvedValue(MEMBER as never);
    vi.mocked(authUserExistsByEmail).mockResolvedValue(false);
    mockInviteUserByEmail.mockResolvedValue({ error: null });

    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "Staffer@Example.com", role: "staff" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.delivery).toBe("auth_invite");
    expect(inviteBusinessMember).toHaveBeenCalledWith({
      businessId: BIZ,
      email: "staffer@example.com",
      role: "staff",
      invitedBy: "owner@example.com",
      employeeId: null
    });
    expect(mockInviteUserByEmail).toHaveBeenCalledWith(
      "staffer@example.com",
      expect.objectContaining({ redirectTo: expect.stringContaining("/reset-password") })
    );
    expect(sendOwnerEmail).not.toHaveBeenCalled();
  });

  it("POST sends the branded notice email when the invitee already has a login", async () => {
    vi.mocked(inviteBusinessMember).mockResolvedValue(MEMBER as never);
    vi.mocked(authUserExistsByEmail).mockResolvedValue(true);
    vi.mocked(sendOwnerEmail).mockResolvedValue("email_1");

    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "staffer@example.com", role: "staff" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.delivery).toBe("notice_email");
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });

  it("POST reports delivery 'none' when email fails — the grant still stands", async () => {
    vi.mocked(inviteBusinessMember).mockResolvedValue(MEMBER as never);
    vi.mocked(authUserExistsByEmail).mockRejectedValue(new Error("auth API down"));

    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "staffer@example.com", role: "staff" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.delivery).toBe("none");
    expect(body.data.member).toEqual(MEMBER);
  });

  it("POST is enterprise-gated", async () => {
    vi.mocked(assertTeamAccessAllowed).mockRejectedValue(
      new TeamAccessValidationError(TEAM_ACCESS_TIER_MESSAGE)
    );
    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "s@example.com", role: "staff" })
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.message).toBe(TEAM_ACCESS_TIER_MESSAGE);
    expect(inviteBusinessMember).not.toHaveBeenCalled();
  });

  it("POST refuses inviting the owner's own email", async () => {
    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "OWNER@example.com", role: "manager" })
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toContain("owner");
    expect(inviteBusinessMember).not.toHaveBeenCalled();
  });

  it("POST maps membership conflicts to 409", async () => {
    vi.mocked(inviteBusinessMember).mockRejectedValue(
      new BusinessMemberConflictError("That email is already on the team")
    );
    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "dupe@example.com", role: "staff" })
    );
    expect(res.status).toBe(409);
  });

  it("POST refuses view-as writes", async () => {
    vi.mocked(isViewAsActive).mockResolvedValue(true);
    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "s@example.com", role: "staff" })
    );
    expect(res.status).toBe(403);
    expect(inviteBusinessMember).not.toHaveBeenCalled();
  });

  it("POST 404s when the business row is missing", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "s@example.com", role: "staff" })
    );
    expect(res.status).toBe(404);
  });

  it("PATCH changes a role and 404s on revoked/missing members", async () => {
    vi.mocked(updateBusinessMemberRole).mockResolvedValue(true);
    const ok = await PATCH(
      jsonRequest("PATCH", { businessId: BIZ, memberId: MEMBER_ID, role: "manager" })
    );
    expect(ok.status).toBe(200);
    expect(updateBusinessMemberRole).toHaveBeenCalledWith(BIZ, MEMBER_ID, "manager");

    vi.mocked(updateBusinessMemberRole).mockResolvedValue(false);
    const missing = await PATCH(
      jsonRequest("PATCH", { businessId: BIZ, memberId: MEMBER_ID, role: "staff" })
    );
    expect(missing.status).toBe(404);
  });

  it("PATCH is enterprise-gated and view-as-refused", async () => {
    vi.mocked(assertTeamAccessAllowed).mockRejectedValue(
      new TeamAccessValidationError(TEAM_ACCESS_TIER_MESSAGE)
    );
    const gated = await PATCH(
      jsonRequest("PATCH", { businessId: BIZ, memberId: MEMBER_ID, role: "manager" })
    );
    expect(gated.status).toBe(403);

    vi.mocked(assertTeamAccessAllowed).mockResolvedValue(undefined);
    vi.mocked(isViewAsActive).mockResolvedValue(true);
    const viewAs = await PATCH(
      jsonRequest("PATCH", { businessId: BIZ, memberId: MEMBER_ID, role: "manager" })
    );
    expect(viewAs.status).toBe(403);
    expect(updateBusinessMemberRole).not.toHaveBeenCalled();
  });

  it("DELETE revokes without a tier gate (downgraded businesses can shed members)", async () => {
    vi.mocked(revokeBusinessMember).mockResolvedValue(true);
    const res = await DELETE(jsonRequest("DELETE", { businessId: BIZ, memberId: MEMBER_ID }));
    expect(res.status).toBe(200);
    expect(revokeBusinessMember).toHaveBeenCalledWith(BIZ, MEMBER_ID);
    expect(assertTeamAccessAllowed).not.toHaveBeenCalled();

    vi.mocked(revokeBusinessMember).mockResolvedValue(false);
    const missing = await DELETE(jsonRequest("DELETE", { businessId: BIZ, memberId: MEMBER_ID }));
    expect(missing.status).toBe(404);
  });

  it("DELETE refuses view-as writes", async () => {
    vi.mocked(isViewAsActive).mockResolvedValue(true);
    const res = await DELETE(jsonRequest("DELETE", { businessId: BIZ, memberId: MEMBER_ID }));
    expect(res.status).toBe(403);
    expect(revokeBusinessMember).not.toHaveBeenCalled();
  });

  it("validates bodies (bad role rejected)", async () => {
    const res = await POST(
      jsonRequest("POST", { businessId: BIZ, email: "s@example.com", role: "owner" })
    );
    expect(res.status).toBe(400);
  });
});
