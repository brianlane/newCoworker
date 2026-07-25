import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));
vi.mock("@/lib/db/agent-tool-settings", () => ({ isAgentToolEnabled: vi.fn() }));
vi.mock("@/lib/voice-tools/staff-caller", () => ({ resolveStaffCaller: vi.fn() }));
vi.mock("@/lib/ai-flows/manual-run-tool", () => ({
  listAiFlowsTool: vi.fn(),
  runAiFlowTool: vi.fn()
}));

import { POST } from "@/app/api/voice/tools/run-aiflow/route";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { resolveStaffCaller } from "@/lib/voice-tools/staff-caller";
import { listAiFlowsTool, runAiFlowTool } from "@/lib/ai-flows/manual-run-tool";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER = "+16025551212";
const STRANGER = "+14805559999";

function req(body: unknown) {
  return new Request("http://localhost/api/voice/tools/run-aiflow", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer gw" },
    body: JSON.stringify(body)
  });
}

/**
 * The voice surface's flow-run tool: the owner phoning their own line can hand
 * work to an automation ("I got a new lead, run my intake"), which no other
 * voice tool could do. The security contract is the interesting part: a
 * CUSTOMER must never be able to start a tenant's automations by asking.
 */
describe("POST /api/voice/tools/run-aiflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw";
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
    vi.mocked(resolveStaffCaller).mockResolvedValue({ kind: "owner", name: "Amy" });
  });

  it("runs the named flow for a staff caller, passing what they said as the trigger text", async () => {
    vi.mocked(runAiFlowTool).mockResolvedValue({
      ok: true,
      runId: "run-1",
      flowName: "New Lead Intake",
      note: "Run enqueued."
    });
    const res = await POST(
      req({
        businessId: BIZ,
        callerE164: OWNER,
        args: { flow: "New Lead Intake", input: "Jane 602 555 1212 wants a quote" }
      })
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      data: { runId: "run-1", flowName: "New Lead Intake" }
    });
    expect(runAiFlowTool).toHaveBeenCalledWith(BIZ, {
      flow: "New Lead Intake",
      input: "Jane 602 555 1212 wants a quote"
    });
  });

  it("lists the automations when no flow was named (so the model never guesses)", async () => {
    vi.mocked(listAiFlowsTool).mockResolvedValue({
      ok: true,
      flows: [{ id: "f1", name: "New Lead Intake", enabled: true, trigger: "manual (run on demand)" }],
      note: "n"
    });
    const res = await POST(req({ businessId: BIZ, callerE164: OWNER, args: {} }));
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      data: { flows: [{ name: "New Lead Intake" }] }
    });
    expect(runAiFlowTool).not.toHaveBeenCalled();
  });

  it("REFUSES a caller who is not staff, and starts nothing", async () => {
    vi.mocked(resolveStaffCaller).mockResolvedValue(null);
    const res = await POST(
      req({ businessId: BIZ, callerE164: STRANGER, args: { flow: "New Lead Intake" } })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("not_staff");
    expect(runAiFlowTool).not.toHaveBeenCalled();
    expect(listAiFlowsTool).not.toHaveBeenCalled();
  });

  it("refuses when the caller id is missing entirely (fails closed)", async () => {
    vi.mocked(resolveStaffCaller).mockResolvedValue(null);
    const res = await POST(req({ businessId: BIZ, args: { flow: "F" } }));
    await expect(res.json()).resolves.toMatchObject({ ok: false, detail: "not_staff" });
  });

  it("passes a core refusal (disabled / unknown / voice-only) back for the AI to explain", async () => {
    vi.mocked(runAiFlowTool).mockResolvedValue({
      ok: false,
      message: '"Voice routing" is a voice flow and cannot be started manually.'
    });
    const res = await POST(req({ businessId: BIZ, callerE164: OWNER, args: { flow: "Voice routing" } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      detail: "refused",
      data: { message: expect.stringContaining("voice flow") }
    });
  });

  it("honors the owner's Settings toggle for the tool", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await POST(req({ businessId: BIZ, callerE164: OWNER, args: { flow: "F" } }));
    await expect(res.json()).resolves.toMatchObject({ ok: false });
    expect(resolveStaffCaller).not.toHaveBeenCalled();
    expect(runAiFlowTool).not.toHaveBeenCalled();
  });

  it("rejects a bad bearer before anything else", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(false);
    const res = await POST(req({ businessId: BIZ, callerE164: OWNER, args: { flow: "F" } }));
    expect(res.status).toBe(401);
    expect(runAiFlowTool).not.toHaveBeenCalled();
  });

  it("rejects a malformed envelope and malformed args", async () => {
    const badEnvelope = await POST(req({ callerE164: OWNER }));
    expect(badEnvelope.status).toBe(400);
    const badArgs = await POST(
      req({ businessId: BIZ, callerE164: OWNER, args: { flow: "x".repeat(300) } })
    );
    expect(badArgs.status).toBe(400);
  });

  it("degrades to a 500 tool result when the core throws", async () => {
    vi.mocked(runAiFlowTool).mockRejectedValue(new Error("boom"));
    const res = await POST(req({ businessId: BIZ, callerE164: OWNER, args: { flow: "F" } }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ ok: false, detail: "internal_error" });
  });
});
