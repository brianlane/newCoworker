/**
 * The AiFlow organize-email gateway, focused on the display-only importance
 * score's boundary rules.
 *
 * Both were Bugbot findings on PR #1433 and both are the same class of mistake:
 * a cosmetic field reaching further than it should. One failed a whole run step
 * when the model returned no number; the other dropped the "I could not score
 * it" signal one layer above where it was created, restoring the silent success
 * the signal exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));
vi.mock("@/lib/email/organize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/organize")>();
  return { ...actual, organizeMessage: vi.fn() };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: vi.fn().mockResolvedValue(undefined)
}));

import { POST } from "@/app/api/aiflows/organize-email/route";
import { organizeMessage } from "@/lib/email/organize";
import { recordSystemLog } from "@/lib/db/system-logs";

const businessId = "11111111-1111-4111-8111-111111111111";
const emailLogId = "22222222-2222-4222-8222-222222222222";

function post(actions: Record<string, unknown>) {
  return POST(
    new Request("https://x/api/aiflows/organize-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, emailLogId, actions })
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(organizeMessage).mockResolvedValue({ ok: true, provider: "tenant" });
});

describe("organize-email: a score the model never produced", () => {
  it("succeeds as a no-op when scoring was the step's only instruction", async () => {
    /**
     * The bug: the planner omits importanceText on an empty render, so a
     * score-only step arrived with no actions at all and the gateway answered
     * `no_organize_actions`. The worker turns any !ok into a FAILED run step,
     * so a flow died because a model declined to emit a digit.
     */
    const res = await post({ importanceText: "" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { detail: "no_score" } });
    expect(organizeMessage).not.toHaveBeenCalled();
  });

  it("does the same for prose, and for a step that sent nothing at all", async () => {
    for (const actions of [{ importanceText: "high" }, {}]) {
      vi.mocked(organizeMessage).mockClear();
      const res = await post(actions);
      expect(await res.json()).toMatchObject({ ok: true, data: { detail: "no_score" } });
      expect(organizeMessage).not.toHaveBeenCalled();
    }
  });

  it("never clears an existing score just because this run produced none", async () => {
    // "the model said nothing" is not "the owner asked for the score removed".
    // Wiping yesterday's good score over today's hiccup is the worse reading,
    // so no `importance` key reaches organizeMessage at all.
    await post({ addLabels: ["HQ/Automated"], importanceText: "high" });
    expect(organizeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ actions: { addLabels: ["HQ/Automated"] } })
    );
  });

  it("still organizes normally when the score parses", async () => {
    await post({ addLabels: ["HQ/Automated"], importanceText: "6/10" });
    expect(organizeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ actions: { addLabels: ["HQ/Automated"], importance: 6 } })
    );
  });

  it("dispatches a score-only step that DID produce a number", async () => {
    await post({ importanceText: "8" });
    expect(organizeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ actions: { importance: 8 } })
    );
  });
});

describe("organize-email: the scoring miss is not silent", () => {
  it("passes the partial detail back and logs it", async () => {
    // organizeMessage says the labelling landed but no email_log row existed to
    // score. That detail was invented to avoid a silent success, so the route
    // must neither swallow it nor turn it into a failure.
    vi.mocked(organizeMessage).mockResolvedValue({
      ok: true,
      provider: "google",
      detail: "importance_row_not_found"
    });
    const res = await post({ addLabels: ["HQ/Automated"], importanceText: "6" });
    expect(await res.json()).toMatchObject({
      ok: true,
      data: { provider: "google", detail: "importance_row_not_found" }
    });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "ai_flow_email_importance_row_missing"
      })
    );
  });

  it("stays quiet on an ordinary success", async () => {
    const res = await post({ addLabels: ["HQ/Automated"] });
    expect(await res.json()).toMatchObject({ ok: true, data: { provider: "tenant" } });
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("still reports a real organize failure as a failure", async () => {
    // The no-op path must not have swallowed genuine errors on its way in.
    vi.mocked(organizeMessage).mockResolvedValue({ ok: false, detail: "connection_not_found" });
    const res = await post({ addLabels: ["HQ/Automated"] });
    expect(await res.json()).toMatchObject({ ok: false, detail: "connection_not_found" });
  });
});
