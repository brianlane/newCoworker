import { describe, expect, it } from "vitest";
import {
  APPROVAL_MAX_REPLY_DIGIT,
  APPROVAL_OPTION_DECISIONS,
  LEGACY_APPROVAL_OPTIONS,
  approvalOptionForReply,
  approvalSmsInstruction,
  buildApprovalGateOptions,
  parseStoredApprovalOptions
} from "../supabase/functions/_shared/ai_flows/approval_options";

describe("buildApprovalGateOptions", () => {
  it("offers approve/skip/cancel when no later step has quiet hours", () => {
    expect(buildApprovalGateOptions({ offerQuietBypass: false })).toEqual([
      "approve",
      "skip",
      "cancel"
    ]);
  });
  it("slots bypass_quiet_hours before cancel, keeping cancel LAST (digit 4)", () => {
    expect(buildApprovalGateOptions({ offerQuietBypass: true })).toEqual([
      "approve",
      "skip",
      "bypass_quiet_hours",
      "cancel"
    ]);
  });
});

describe("approvalSmsInstruction", () => {
  it("renders the 3-option legacy offer", () => {
    expect(approvalSmsInstruction(["approve", "skip", "cancel"])).toBe(
      "Reply 1 to approve, 2 to skip this step, or 3 to cancel the workflow."
    );
  });
  it("renders the 4-option offer with cancel as the last digit", () => {
    expect(
      approvalSmsInstruction(["approve", "skip", "bypass_quiet_hours", "cancel"])
    ).toBe(
      "Reply 1 to approve, 2 to skip this step, 3 to approve and skip quiet hours " +
        "for the rest of this workflow, or 4 to cancel the workflow."
    );
  });
  it("renders a single option without a trailing 'or'", () => {
    expect(approvalSmsInstruction(["approve"])).toBe("Reply 1 to approve.");
  });
});

describe("parseStoredApprovalOptions", () => {
  it("round-trips a stored list", () => {
    expect(parseStoredApprovalOptions(["approve", "skip", "bypass_quiet_hours", "cancel"])).toEqual(
      ["approve", "skip", "bypass_quiet_hours", "cancel"]
    );
  });
  it("falls back to the legacy 1/2/3 offer for missing or empty values", () => {
    expect(parseStoredApprovalOptions(undefined)).toEqual(LEGACY_APPROVAL_OPTIONS);
    expect(parseStoredApprovalOptions(null)).toEqual(LEGACY_APPROVAL_OPTIONS);
    expect(parseStoredApprovalOptions([])).toEqual(LEGACY_APPROVAL_OPTIONS);
    expect(parseStoredApprovalOptions("approve")).toEqual(LEGACY_APPROVAL_OPTIONS);
  });
  it("invalidates the WHOLE list on any unknown entry (no silent renumbering)", () => {
    expect(parseStoredApprovalOptions(["approve", "self_destruct", "cancel"])).toEqual(
      LEGACY_APPROVAL_OPTIONS
    );
    expect(parseStoredApprovalOptions(["approve", 2, "cancel"])).toEqual(LEGACY_APPROVAL_OPTIONS);
  });
});

describe("approvalOptionForReply", () => {
  const offered = ["approve", "skip", "bypass_quiet_hours", "cancel"] as const;
  it("maps each digit to the offered option", () => {
    expect(approvalOptionForReply([...offered], "1")).toBe("approve");
    expect(approvalOptionForReply([...offered], "2")).toBe("skip");
    expect(approvalOptionForReply([...offered], "3")).toBe("bypass_quiet_hours");
    expect(approvalOptionForReply([...offered], "4")).toBe("cancel");
  });
  it("maps digit 3 to cancel when only the legacy three options were offered", () => {
    expect(approvalOptionForReply([...LEGACY_APPROVAL_OPTIONS], "3")).toBe("cancel");
    expect(approvalOptionForReply([...LEGACY_APPROVAL_OPTIONS], "4")).toBeNull();
  });
  it("tolerates whitespace and rejects non-digit / out-of-range replies", () => {
    expect(approvalOptionForReply([...offered], " 2 ")).toBe("skip");
    expect(approvalOptionForReply([...offered], "0")).toBeNull();
    expect(approvalOptionForReply([...offered], "5")).toBeNull();
    expect(approvalOptionForReply([...offered], "yes")).toBeNull();
    expect(approvalOptionForReply([...offered], "123")).toBeNull();
  });
});

describe("decision mapping", () => {
  it("maps cancel to the legacy 'deny' decision and the rest to themselves", () => {
    expect(APPROVAL_OPTION_DECISIONS.approve).toBe("approve");
    expect(APPROVAL_OPTION_DECISIONS.skip).toBe("skip");
    expect(APPROVAL_OPTION_DECISIONS.bypass_quiet_hours).toBe("bypass_quiet_hours");
    expect(APPROVAL_OPTION_DECISIONS.cancel).toBe("deny");
  });
  it("exposes the webhook fast-path digit ceiling", () => {
    expect(APPROVAL_MAX_REPLY_DIGIT).toBe(4);
  });
});
