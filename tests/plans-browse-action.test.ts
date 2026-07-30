import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness,
  browseActionAllowedForTier
} from "@/lib/plans/browse-action";
import {
  collectBrowseActionSteps,
  flowStepsIncludeBrowseAction,
  validateBrowseActionSteps
} from "@/lib/ai-flows/browse-action-steps";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { AiFlowDefinition, FlowStep } from "@/lib/ai-flows/schema";

function makeDb(result: { data: unknown; error: { message: string } | null }) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(result)
        })
      })
    })
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("browse_action tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(browseActionAllowedForTier("standard")).toBe(true);
    expect(browseActionAllowedForTier("enterprise")).toBe(true);
    expect(browseActionAllowedForTier("starter")).toBe(false);
    expect(browseActionAllowedForTier(null)).toBe(false);
  });

  it("exposes an upgrade message naming the Standard plan", () => {
    expect(BROWSE_ACTION_UPGRADE_MESSAGE).toContain("Standard");
  });

  it("resolves the tier for a business", async () => {
    expect(
      await browseActionAllowedForBusiness(
        "biz-1",
        makeDb({ data: { tier: "standard" }, error: null })
      )
    ).toBe(true);
    expect(
      await browseActionAllowedForBusiness(
        "biz-1",
        makeDb({ data: { tier: "starter" }, error: null })
      )
    ).toBe(false);
  });

  it("creates a service client when none is provided", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "enterprise" }, error: null })
    );
    expect(await browseActionAllowedForBusiness("biz-1")).toBe(true);
  });

  it("throws on lookup errors", async () => {
    await expect(
      browseActionAllowedForBusiness("biz-1", makeDb({ data: null, error: { message: "db down" } }))
    ).rejects.toThrow("browseActionAllowedForBusiness: db down");
  });
});

describe("validateBrowseActionSteps", () => {
  const defWithBrowse = {
    trigger: { channel: "manual" },
    steps: [
      {
        id: "s1",
        type: "browse_action",
        url: "https://example.com",
        actions: [{ type: "click", selector: "#go" }]
      }
    ]
  } as unknown as AiFlowDefinition;

  it("collects browse_action steps including nested branches", () => {
    const def = {
      trigger: { channel: "manual" },
      steps: [
        { id: "a", type: "browse_action", url: "https://a.test", actions: [] },
        {
          id: "b",
          type: "branch",
          branches: [
            {
              id: "arm1",
              label: "yes",
              when: { var: "x", op: "eq", value: "1" },
              steps: [{ id: "c", type: "browse_action", url: "https://c.test", actions: [] }]
            }
          ],
          else: [{ id: "d", type: "send_sms", to: "+1", body: "hi" }]
        }
      ]
    } as unknown as AiFlowDefinition;
    expect(collectBrowseActionSteps(def).sort()).toEqual(["a", "c"]);
  });

  it("returns no issues when there are no browse_action steps", async () => {
    const def = {
      trigger: { channel: "manual" },
      steps: [{ id: "s", type: "send_sms", to: "+1", body: "hi" }]
    } as unknown as AiFlowDefinition;
    expect(await validateBrowseActionSteps("biz", def)).toEqual([]);
  });

  it("returns the upgrade message on Starter when browse_action is present", async () => {
    const issues = await validateBrowseActionSteps("biz", defWithBrowse, {
      allowedForBusiness: async () => false
    });
    expect(issues).toEqual([BROWSE_ACTION_UPGRADE_MESSAGE]);
  });

  it("allows browse_action when the tier is entitled", async () => {
    const issues = await validateBrowseActionSteps("biz", defWithBrowse, {
      allowedForBusiness: async () => true
    });
    expect(issues).toEqual([]);
  });

  it("uses browseActionAllowedForBusiness when no deps are injected", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "starter" }, error: null })
    );
    const issues = await validateBrowseActionSteps("biz", defWithBrowse);
    expect(issues).toEqual([BROWSE_ACTION_UPGRADE_MESSAGE]);
  });

  it("detects browse_action nested under a branch for the editor banner", () => {
    const steps = [
      {
        id: "b",
        type: "branch",
        branches: [
          {
            id: "arm1",
            label: "yes",
            when: { var: "x", op: "eq", value: "1" },
            steps: [{ id: "c", type: "browse_action", url: "https://c.test", actions: [] }]
          }
        ],
        else: []
      }
    ] as unknown as FlowStep[];
    expect(flowStepsIncludeBrowseAction(steps)).toBe(true);
    expect(
      flowStepsIncludeBrowseAction([
        {
          id: "b2",
          type: "branch",
          branches: [
            {
              id: "arm-sms",
              label: "yes",
              when: { var: "x", op: "eq", value: "1" },
              steps: [{ id: "s", type: "send_sms", to: "+1", body: "hi" }]
            }
          ],
          else: [{ id: "e", type: "browse_action", url: "https://e.test", actions: [] }]
        } as never
      ])
    ).toBe(true);
    expect(
      flowStepsIncludeBrowseAction([
        {
          id: "b3",
          type: "branch",
          branches: [
            {
              id: "arm-sms2",
              label: "yes",
              when: { var: "x", op: "eq", value: "1" },
              steps: [{ id: "s2", type: "send_sms", to: "+1", body: "hi" }]
            }
          ],
          else: [{ id: "s3", type: "send_sms", to: "+1", body: "bye" }]
        } as never
      ])
    ).toBe(false);
    expect(flowStepsIncludeBrowseAction([{ id: "s", type: "send_sms", to: "+1", body: "hi" } as never])).toBe(
      false
    );
  });

  it("allows via default business lookup on Standard", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "standard" }, error: null })
    );
    expect(await validateBrowseActionSteps("biz", defWithBrowse)).toEqual([]);
  });
});
