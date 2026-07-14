/**
 * applyWhiteGloveIntake (src/lib/white-glove/apply-service.ts): guards,
 * vault marker writes, hours handling, and the create-vs-update flow install.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockResolvedValue({})
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessProfileFields: vi.fn()
}));

vi.mock("@/lib/db/configs", () => ({
  getBusinessConfig: vi.fn(),
  patchBusinessConfig: vi.fn()
}));

vi.mock("@/lib/ai-flows/db", () => ({
  createAiFlow: vi.fn(),
  getAiFlow: vi.fn(),
  listAiFlows: vi.fn(),
  updateAiFlow: vi.fn()
}));

vi.mock("@/lib/business-profile/refresh", () => ({
  refreshBusinessProfileMdAndLog: vi.fn().mockResolvedValue("profile")
}));

vi.mock("@/lib/white-glove/intake", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/white-glove/intake")>();
  return {
    ...actual,
    claimWhiteGloveIntakeForBusiness: vi.fn(),
    getWhiteGloveIntake: vi.fn(),
    markWhiteGloveIntakeApplied: vi.fn()
  };
});

import {
  applyWhiteGloveIntake,
  WhiteGloveApplyError
} from "@/lib/white-glove/apply-service";
import {
  WHITE_GLOVE_BLOCK_END,
  WHITE_GLOVE_BLOCK_START,
  INTAKE_FOLLOW_UP_FLOW_NAME
} from "@/lib/white-glove/apply";
import { getBusiness, updateBusinessProfileFields } from "@/lib/db/businesses";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { createAiFlow, getAiFlow, listAiFlows, updateAiFlow } from "@/lib/ai-flows/db";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import {
  claimWhiteGloveIntakeForBusiness,
  getWhiteGloveIntake,
  markWhiteGloveIntakeApplied
} from "@/lib/white-glove/intake";
import type { WhiteGloveIntakeRow } from "@/lib/white-glove/intake";
import type { IntakeAnswers } from "@/lib/white-glove/template";

const INTAKE_ID = "0f0f0f0f-0000-4000-8000-000000000001";
const BIZ_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";
const FLOW_ID = "44444444-4444-4444-8444-444444444444";

const ANSWERS: IntakeAnswers = {
  business_hours: "11am to 6pm",
  team: "James - 514-518-8192",
  lead_sources: ["facebook_instagram", "website_form"],
  lead_sources_other: "",
  greeting: "Hey {name}, grab a time: calendly.com/james-kyp-ads/my-free-scale-plan",
  qualification_questions: "",
  appointment_length: "30",
  appointment_buffer: "none",
  booking_notice: "2h",
  booking_window: "1w",
  first_follow_up: "2h",
  second_follow_up: "next_day",
  handoff_after: "3_attempts",
  never_handle: ["pricing"],
  never_handle_other: "",
  consent_confirmed: "yes",
  notes: ""
};

function intakeRow(overrides: Partial<WhiteGloveIntakeRow> = {}): WhiteGloveIntakeRow {
  return {
    id: INTAKE_ID,
    token: "0f0f0f0f-0000-4000-8000-0000000000aa",
    business_name: "Kyp Ads",
    industry: "other",
    recipient_email: "james@kypads.com",
    business_id: null,
    answers: ANSWERS,
    status: "completed",
    created_by: "admin@test.com",
    created_at: "2026-07-14T00:00:00Z",
    completed_at: "2026-07-14T01:00:00Z",
    applied_at: null,
    applied_flow_id: null,
    ...overrides
  };
}

describe("applyWhiteGloveIntake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWhiteGloveIntake).mockResolvedValue(intakeRow());
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, name: "KYP Ads" } as never);
    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ_ID,
      soul_md: "# soul.md\nOwner soul.",
      identity_md: "",
      memory_md: "# memory.md\nOwner memory.",
      website_md: "",
      updated_at: "2026-07-14T00:00:00Z"
    });
    vi.mocked(createAiFlow).mockResolvedValue({ id: FLOW_ID } as never);
    vi.mocked(updateAiFlow).mockResolvedValue({ id: FLOW_ID } as never);
    vi.mocked(listAiFlows).mockResolvedValue([]);
    vi.mocked(claimWhiteGloveIntakeForBusiness).mockResolvedValue(true);
  });

  it("guards: unknown intake, not completed, tied elsewhere, unknown business", async () => {
    vi.mocked(getWhiteGloveIntake).mockResolvedValue(null);
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toMatchObject({ code: "intake_not_found" });

    vi.mocked(getWhiteGloveIntake).mockResolvedValue(intakeRow({ status: "sent", answers: null }));
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toMatchObject({ code: "intake_not_completed" });

    // A completed row whose answers are somehow missing is equally unusable.
    vi.mocked(getWhiteGloveIntake).mockResolvedValue(intakeRow({ answers: null }));
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toMatchObject({ code: "intake_not_completed" });

    vi.mocked(getWhiteGloveIntake).mockResolvedValue(
      intakeRow({ business_id: "99999999-9999-4999-8999-999999999999" })
    );
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toBeInstanceOf(WhiteGloveApplyError);

    vi.mocked(getWhiteGloveIntake).mockResolvedValue(intakeRow());
    vi.mocked(getBusiness).mockResolvedValue(null);
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toMatchObject({ code: "business_not_found" });
    expect(patchBusinessConfig).not.toHaveBeenCalled();
  });

  it("loses the atomic claim race cleanly — nothing is written", async () => {
    // Two overlapping applies to different tenants both pass the read-time
    // mismatch check; the conditional-UPDATE claim lets exactly one through.
    vi.mocked(claimWhiteGloveIntakeForBusiness).mockResolvedValue(false);
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toMatchObject({ code: "intake_business_mismatch" });
    expect(claimWhiteGloveIntakeForBusiness).toHaveBeenCalledWith(
      INTAKE_ID,
      BIZ_ID,
      expect.anything()
    );
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    expect(createAiFlow).not.toHaveBeenCalled();
    expect(markWhiteGloveIntakeApplied).not.toHaveBeenCalled();
  });

  it("first apply: writes marker blocks, hours, installs the flow DISABLED, stamps the intake", async () => {
    const result = await applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID });
    expect(result).toEqual({ flowId: FLOW_ID, flowCreated: true, businessHoursApplied: true });

    // Vault: owner text preserved, block appended to both docs.
    const patch = vi.mocked(patchBusinessConfig).mock.calls[0][1];
    expect(patch.soul_md).toContain("Owner soul.");
    expect(patch.soul_md).toContain(WHITE_GLOVE_BLOCK_START);
    expect(patch.soul_md).toContain(WHITE_GLOVE_BLOCK_END);
    expect(patch.memory_md).toContain("Owner memory.");
    expect(patch.memory_md).toContain("### Scheduling rules");

    // Hours parsed → profile fields + profile_md refresh.
    expect(updateBusinessProfileFields).toHaveBeenCalledWith(
      BIZ_ID,
      { business_hours: expect.objectContaining({ mon: { open: "11:00", close: "18:00" } }) },
      expect.anything()
    );
    expect(refreshBusinessProfileMdAndLog).toHaveBeenCalledWith(BIZ_ID, expect.anything());

    // The flow goes in disabled for wording review.
    expect(createAiFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ_ID,
        name: INTAKE_FOLLOW_UP_FLOW_NAME,
        enabled: false
      }),
      expect.anything()
    );
    expect(getAiFlow).not.toHaveBeenCalled();

    expect(markWhiteGloveIntakeApplied).toHaveBeenCalledWith(
      INTAKE_ID,
      { businessId: BIZ_ID, flowId: FLOW_ID },
      expect.anything()
    );
  });

  it("re-apply: updates the installed flow in place and replaces its own block only", async () => {
    vi.mocked(getWhiteGloveIntake).mockResolvedValue(
      intakeRow({
        business_id: BIZ_ID,
        applied_at: "2026-07-14T02:00:00Z",
        applied_flow_id: FLOW_ID
      })
    );
    vi.mocked(getAiFlow).mockResolvedValue({ id: FLOW_ID, enabled: true } as never);
    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ_ID,
      soul_md: `Owner soul.\n\n${WHITE_GLOVE_BLOCK_START}\nold block\n${WHITE_GLOVE_BLOCK_END}\n`,
      identity_md: "",
      memory_md: "",
      website_md: "",
      updated_at: "2026-07-14T00:00:00Z"
    });

    const result = await applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID });
    expect(result.flowCreated).toBe(false);
    expect(updateAiFlow).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ_ID, id: FLOW_ID }),
      expect.anything()
    );
    // enabled untouched on update — the owner's toggle survives a re-apply.
    expect(vi.mocked(updateAiFlow).mock.calls[0][0]).not.toHaveProperty("enabled");
    expect(createAiFlow).not.toHaveBeenCalled();

    const patch = vi.mocked(patchBusinessConfig).mock.calls[0][1];
    expect(patch.soul_md).toContain("Owner soul.");
    expect(patch.soul_md).not.toContain("old block");
    expect((patch.soul_md as string).match(/white-glove-build:start/g)).toHaveLength(1);
  });

  it("re-apply after the owner deleted the flow installs a fresh one", async () => {
    vi.mocked(getWhiteGloveIntake).mockResolvedValue(
      intakeRow({ business_id: BIZ_ID, applied_flow_id: FLOW_ID })
    );
    vi.mocked(getAiFlow).mockResolvedValue(null);

    const result = await applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID });
    expect(result.flowCreated).toBe(true);
    expect(updateAiFlow).not.toHaveBeenCalled();
    expect(createAiFlow).toHaveBeenCalled();
  });

  it("retry after a failed stamp finds the flow BY NAME instead of duplicating it", async () => {
    // Previous apply created the flow but died before markWhiteGloveIntakeApplied
    // → the intake carries no applied_flow_id, yet the flow exists.
    vi.mocked(listAiFlows).mockResolvedValue([
      { id: "other-flow", name: "Some other automation" },
      { id: FLOW_ID, name: INTAKE_FOLLOW_UP_FLOW_NAME }
    ] as never);

    const result = await applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID });
    expect(result).toMatchObject({ flowId: FLOW_ID, flowCreated: false });
    expect(getAiFlow).not.toHaveBeenCalled();
    expect(updateAiFlow).toHaveBeenCalledWith(
      expect.objectContaining({ id: FLOW_ID }),
      expect.anything()
    );
    expect(createAiFlow).not.toHaveBeenCalled();
  });

  it("merges parsed hours over the tenant's existing days instead of replacing them", async () => {
    // Owner configured Saturday in Settings; the dayless intake ("11am to
    // 6pm" → Mon–Fri) must not wipe it.
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      name: "KYP Ads",
      business_hours: {
        sat: { open: "10:00", close: "14:00" },
        mon: { open: "08:00", close: "12:00" },
        bogus_key: "dropped by the tolerant parser"
      }
    } as never);

    await applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID });
    expect(updateBusinessProfileFields).toHaveBeenCalledWith(
      BIZ_ID,
      {
        business_hours: expect.objectContaining({
          sat: { open: "10:00", close: "14:00" },
          // The intake's Mon–Fri window wins over the stale Monday hours.
          mon: { open: "11:00", close: "18:00" },
          fri: { open: "11:00", close: "18:00" }
        })
      },
      expect.anything()
    );
  });

  it("handles a missing config row (fresh vault) and unparseable hours", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue(null);
    vi.mocked(getWhiteGloveIntake).mockResolvedValue(
      intakeRow({ answers: { ...ANSWERS, business_hours: "flexible" } })
    );
    const result = await applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID });
    expect(result.businessHoursApplied).toBe(false);
    expect(updateBusinessProfileFields).not.toHaveBeenCalled();
    expect(refreshBusinessProfileMdAndLog).not.toHaveBeenCalled();
    const patch = vi.mocked(patchBusinessConfig).mock.calls[0][1];
    expect((patch.soul_md as string).startsWith(WHITE_GLOVE_BLOCK_START)).toBe(true);
  });

  it("fails loudly BEFORE the claim when a vault doc would exceed its cap", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ_ID,
      soul_md: "x".repeat(31_900),
      identity_md: "",
      memory_md: "",
      website_md: "",
      updated_at: "2026-07-14T00:00:00Z"
    });
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toMatchObject({ code: "vault_over_limit" });
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    // The refusal happens before the claim, so it never pins the intake.
    expect(claimWhiteGloveIntakeForBusiness).not.toHaveBeenCalled();

    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ_ID,
      soul_md: "",
      identity_md: "",
      memory_md: "x".repeat(13_900),
      website_md: "",
      updated_at: "2026-07-14T00:00:00Z"
    });
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toMatchObject({ code: "vault_over_limit" });
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    expect(claimWhiteGloveIntakeForBusiness).not.toHaveBeenCalled();
  });

  it("keeps the claim when a write fails mid-apply (re-apply to the SAME tenant heals)", async () => {
    // Data may already have landed on this tenant, so the claim must stay:
    // releasing it would let a later apply re-point the intake at a
    // different business while this one holds partial build data.
    vi.mocked(patchBusinessConfig).mockRejectedValue(new Error("db down"));
    await expect(
      applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BIZ_ID })
    ).rejects.toThrow("db down");
    expect(claimWhiteGloveIntakeForBusiness).toHaveBeenCalled();
    expect(markWhiteGloveIntakeApplied).not.toHaveBeenCalled();
  });
});
