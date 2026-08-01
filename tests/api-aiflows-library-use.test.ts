import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitDurable: vi.fn().mockResolvedValue({ success: true })
}));
vi.mock("@/lib/ai-flows/db", () => ({ createAiFlow: vi.fn() }));
vi.mock("@/lib/ai-flows/library", () => ({
  getAiFlowLibraryEntry: vi.fn(),
  recordLibraryDownload: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockResolvedValue({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: { phone: "+15550001111" } });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
      return chain;
    }
  })
}));
vi.mock("@/lib/ai-flows/document-steps", () => ({
  validateShareDocumentSteps: vi.fn().mockResolvedValue([])
}));
vi.mock("@/lib/ai-flows/agent-steps", () => ({
  validateRunAgentSteps: vi.fn().mockResolvedValue([])
}));
vi.mock("@/lib/ai-flows/mailbox-steps", () => ({
  validateMailboxConnectionSteps: vi.fn().mockResolvedValue([])
}));
vi.mock("@/lib/ai-flows/browse-action-steps", () => ({
  validateBrowseActionSteps: vi.fn().mockResolvedValue([])
}));

import { POST } from "@/app/api/aiflows/library/[id]/use/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { createAiFlow } from "@/lib/ai-flows/db";
import { getAiFlowLibraryEntry } from "@/lib/ai-flows/library";
import { validateBrowseActionSteps } from "@/lib/ai-flows/browse-action-steps";
import { validateShareDocumentSteps } from "@/lib/ai-flows/document-steps";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const BIZ = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";

function req(body?: unknown) {
  return new Request(`http://localhost/api/aiflows/library/${ENTRY}/use`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? { businessId: BIZ })
  });
}

const ctx = { params: Promise.resolve({ id: ENTRY }) };

/**
 * Every other save path (POST /api/aiflows, PATCH /api/aiflows/[id], the MCP
 * tool, both compile paths) runs the four binding validators before
 * createAiFlow. This route called createAiFlow directly, so a Starter owner
 * could install a library flow containing a browse_action step: it saved
 * clean with no upgrade message and then failed silently at run time in the
 * worker, the exact outcome #1037's save-time gate exists to prevent.
 */
describe("api/aiflows/library/[id]/use route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(OWNER as never);
    vi.mocked(getAiFlowLibraryEntry).mockResolvedValue({
      id: ENTRY,
      template_key: "outreach-basic",
      title: "Lead follow-up",
      scrubbed_definition: {
        version: 1,
        trigger: { channel: "manual" },
        steps: [{ id: "s1", type: "sleep", minutes: 1 }]
      }
    } as never);
    vi.mocked(createAiFlow).mockResolvedValue({ id: "flow-1" } as never);
    vi.mocked(validateShareDocumentSteps).mockResolvedValue([]);
    vi.mocked(validateBrowseActionSteps).mockResolvedValue([]);
  });

  it("refuses an install whose flow carries a gated browse_action step", async () => {
    vi.mocked(validateBrowseActionSteps).mockResolvedValue([
      "browse_action steps are a Standard plan feature."
    ]);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { message: string } };
    expect(payload.error.message).toMatch(/Standard/);
    expect(createAiFlow).not.toHaveBeenCalled();
  });

  it("refuses on any other binding issue too, matching the sibling save paths", async () => {
    vi.mocked(validateShareDocumentSteps).mockResolvedValue([
      'Step "s1" shares a document that no longer exists.'
    ]);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(400);
    expect(createAiFlow).not.toHaveBeenCalled();
  });

  it("installs a clean flow and runs every validator against the FILLED definition", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(201);
    expect(createAiFlow).toHaveBeenCalled();
    // Substitutions run before validation, so validators see what will
    // actually be saved, not the scrubbed template.
    expect(validateBrowseActionSteps).toHaveBeenCalledWith(BIZ, expect.anything());
  });
});
