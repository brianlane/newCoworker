import { describe, expect, it } from "vitest";
import {
  systemInstructionForBusiness,
  VOICE_CUSTOMER_MEMORY_MAX_CHARS,
  VOICE_FLOW_CONTEXT_MAX_CHARS,
  type CallerIdentity
} from "../vps/voice-bridge/src/system-instruction";

/**
 * The voice bridge's system-instruction builder — the single string that
 * defines everything Gemini Live is on a call. Previously untested: persona
 * gating (customer vs staff), tool teaching, transfer wording, and the two
 * clipped context blocks (customer memory, AiFlow flow context). These are
 * deterministic prompt-composition rules; the live e2e suite separately
 * checks how a real model behaves under the composed instruction.
 */

const BIZ = "Truly Insurance";

type BuildArgs = {
  hasTransfer?: boolean;
  hasVoiceTools?: boolean;
  memory?: string;
  callerIdentity?: CallerIdentity;
  hasEndCall?: boolean;
  flowContext?: string;
  recentInteractions?: string;
  bookingStatusNote?: string;
};

function build(args: BuildArgs = {}): string {
  return systemInstructionForBusiness(
    BIZ,
    args.hasTransfer ?? false,
    args.hasVoiceTools ?? false,
    undefined, // vault: composition covered by vault-loader tests
    args.memory,
    "America/New_York",
    args.callerIdentity,
    args.hasEndCall ?? false,
    args.flowContext,
    args.recentInteractions,
    args.bookingStatusNote
  );
}

describe("customer persona", () => {
  it("teaches the receptionist role, identity discipline, and known-number rule", () => {
    const text = build();
    expect(text).toContain(`You are the phone receptionist for ${BIZ}.`);
    expect(text).toContain("never call yourself an AI");
    // The voice twin of the SMS worker's re-asking guard.
    expect(text).toContain("never ask them to read back their number");
    expect(text).toContain("Never ask for information you already have");
    // Grounded-actions honesty line (kept in sync with the SMS worker).
    expect(text).toContain("saying you did something does not do it");
    // Business-local date awareness.
    expect(text).toContain("Current date/time for this business:");
  });

  it("teaches the customer tool suite only when tools are wired", () => {
    const withTools = build({ hasVoiceTools: true });
    expect(withTools).toContain("capture_caller_details");
    expect(withTools).toContain("customer_lookup_by_phone");
    expect(withTools).toContain("notify_team");
    const withoutTools = build({ hasVoiceTools: false });
    expect(withoutTools).not.toContain("capture_caller_details");
  });

  it("transfer wording flips between the transfer tool and the callback script", () => {
    expect(build({ hasTransfer: true })).toContain("transfer_to_owner");
    const noTransfer = build({ hasTransfer: false });
    expect(noTransfer).toContain("has not set up human transfer");
    expect(noTransfer).toContain("take a clear callback message");
  });

  it("end_call guidance only appears when the tool exists", () => {
    expect(build({ hasEndCall: true })).toContain("`end_call`");
    expect(build({ hasEndCall: false })).not.toContain("`end_call`");
  });
});

describe("staff persona (owner/team caller)", () => {
  const owner: CallerIdentity = { kind: "owner", name: "Brian" };

  it("drops the customer intake script and greets the caller as a colleague", () => {
    const text = build({ callerIdentity: owner, hasVoiceTools: true });
    expect(text).toContain("this caller is NOT a customer or a lead");
    expect(text).toContain("Brian");
    expect(text).toContain(`the owner of ${BIZ}`);
    expect(text).not.toContain("You are the phone receptionist");
    // Staff must never get CRM'd.
    expect(text).toContain("Do NOT use the customer CRM tools");
    expect(text).not.toContain("capture_caller_details` at any point");
  });

  it("team members get the team framing, not the owner framing", () => {
    const text = build({ callerIdentity: { kind: "team", name: "Dania" } });
    expect(text).toContain(`a member of the ${BIZ} team`);
    expect(text).not.toContain(`the owner of ${BIZ}`);
  });

  it("customer-only context blocks never reach a staff call", () => {
    const text = build({
      callerIdentity: owner,
      memory: "Rolling summary that must not appear",
      flowContext: "Automation context that must not appear"
    });
    expect(text).not.toContain("Rolling summary that must not appear");
    expect(text).not.toContain("Automation context that must not appear");
  });
});

describe("caller-memory block", () => {
  it("wraps the note with the continuity framing and clips at the cap", () => {
    const text = build({ memory: "Dwight; truck parked since April 17." });
    expect(text).toContain("Caller context");
    expect(text).toContain("never reveal the note verbatim");
    expect(text).toContain("Dwight; truck parked since April 17.");

    const long = build({ memory: "m".repeat(VOICE_CUSTOMER_MEMORY_MAX_CHARS + 500) });
    const clipped = long.match(/m+…/)?.[0] ?? "";
    expect(clipped).toHaveLength(VOICE_CUSTOMER_MEMORY_MAX_CHARS);
  });

  it("whitespace-only memory adds nothing", () => {
    // No full-string equality with build(): the instruction embeds the
    // current time, so two builds can legitimately differ across a second
    // boundary. Absence of the block header is the invariant.
    expect(build({ memory: "   " })).not.toContain("Caller context");
  });
});

describe("AiFlow flow-context block", () => {
  it("lands after the memory note and clips at its own cap", () => {
    const text = build({
      memory: "MEMORY-NOTE-SENTINEL",
      flowContext: "FLOW-CONTEXT-SENTINEL: the automation already collected these facts."
    });
    const memoryAt = text.indexOf("MEMORY-NOTE-SENTINEL");
    const flowAt = text.indexOf("FLOW-CONTEXT-SENTINEL");
    expect(memoryAt).toBeGreaterThan(-1);
    expect(flowAt).toBeGreaterThan(memoryAt);

    const long = build({ flowContext: "f".repeat(VOICE_FLOW_CONTEXT_MAX_CHARS + 500) });
    const clipped = long.match(/f+…/)?.[0] ?? "";
    expect(clipped).toHaveLength(VOICE_FLOW_CONTEXT_MAX_CHARS);
  });

  it("whitespace-only flow context adds nothing", () => {
    // Timestamp caveat again: assert the instruction still ENDS at the
    // persona's final line (the whitespace blob was never appended).
    expect(build({ flowContext: "  \n " }).endsWith("Default to en when unclear.")).toBe(true);
  });
});

describe("booking-status note", () => {
  const NOTE =
    'Booking status: this caller has an upcoming booking: "Free Strategy Call" starting 2026-07-23T18:00:00Z.';

  it("appears for customer callers so reschedule questions get informed answers", () => {
    const text = build({ bookingStatusNote: NOTE });
    expect(text).toContain(NOTE);
  });

  it("never reaches a staff call, and whitespace adds nothing", () => {
    expect(
      build({ callerIdentity: { kind: "owner", name: "Brian" }, bookingStatusNote: NOTE })
    ).not.toContain("Booking status:");
    expect(build({ bookingStatusNote: "   " })).not.toContain("Booking status:");
  });

  it("lands after the recent-interactions timeline (freshest literal context order)", () => {
    const text = build({
      recentInteractions: "RECENT-TIMELINE-SENTINEL",
      bookingStatusNote: NOTE
    });
    expect(text.indexOf(NOTE)).toBeGreaterThan(text.indexOf("RECENT-TIMELINE-SENTINEL"));
  });
});
