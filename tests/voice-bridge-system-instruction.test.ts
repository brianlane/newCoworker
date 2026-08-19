import { describe, expect, it } from "vitest";
import {
  systemInstructionForBusiness,
  VOICE_CUSTOMER_MEMORY_MAX_CHARS,
  VOICE_FLOW_CONTEXT_MAX_CHARS,
  type CallerIdentity
} from "../vps/voice-bridge/src/system-instruction";

/**
 * The voice bridge's system-instruction builder, the single string that
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

  // Jul 30 2026: a real prospect finished a whole demo-line call unnamed.
  // Every other name rule in this persona is suppressive and the capture tool
  // only fires on a volunteered name, so nothing ever asked.
  it("asks an unrecognized lead for their name, once, without loosening the re-asking rules", () => {
    const text = build();
    expect(text).toContain("can I get your name?");
    // Scoped: lead-shaped callers only, and only when it is not already known.
    expect(text).toContain("turning into a genuine lead");
    expect(text).toContain("still don't know their name");
    expect(text).toContain("Only once in the whole call");
    // The suppressive rules it sits beside must survive intact.
    expect(text).toContain("don't ask for their name again");
    expect(text).toContain("Never ask for information you already have");
  });

  // Aug 3 2026: Chris Bartelot opened with "this is Chris Bartelot" and was
  // asked for his "full name" sixteen turns later. The repeat mis-transcribed
  // as a different surname, the write was refused, and the AI announced it had
  // updated his name. The ask-once permission above had become the re-asking
  // the rules beside it exist to prevent.
  it("blocks the ask when the caller already gave a name earlier in the call", () => {
    const text = build();
    expect(text).toContain("already said their name at ANY point in this call");
    expect(text).toContain("do NOT ask again");
    // The model escalated a permitted "can I get your name?" into a full-name
    // request on its own, so that escalation is closed off by name.
    expect(text).toContain("first name only");
    expect(text).toContain('never a "full name"');
    expect(text).toContain("never ask them to repeat or spell a name they have already given");
  });

  it("tells the model a refused name write is not a success", () => {
    const text = build({ hasVoiceTools: true });
    expect(text).toContain("only fills a BLANK name");
    // Keyed on the result's message rather than on `ok`, because
    // `updated: false` covers both a refusal and a name that is already
    // correctly on file.
    expect(text).toContain('Do not read `ok: true` as "the name was changed"');
    expect(text).toContain("read the result's `message`");
    expect(text).toContain("never claim you updated or corrected a name");
  });

  it("tells the capture tool to omit an unknown name rather than invent a placeholder", () => {
    // The placeholder guards in the filing path are the backstop; this stops
    // the model producing one in the first place.
    expect(build({ hasVoiceTools: true })).toContain("never substitute a placeholder");
  });

  // All three from Chris Bartelot's Aug 3 2026 call.
  describe("Aug 3 2026 call regressions", () => {
    it("ties a follow-up promise to the notify_team call that keeps it", () => {
      // It said "I'll have the team follow up with you" and never called the
      // tool. Nothing reached the team.
      const text = build({ hasVoiceTools: true });
      expect(text).toContain("is a PROMISE");
      expect(text).toContain("I'll have the team follow up");
      expect(text).toContain("call it in the same turn");
    });

    it("bans leading with a slot inside the hour, and re-asking over the caller", () => {
      // It offered "2:30 today, in about fifteen minutes" for an in-person
      // listing consultation, four times, while he was reading out addresses.
      const text = build({ hasVoiceTools: true });
      expect(text).toContain("Do not lead with a slot that starts within the hour");
      expect(text).toContain("Ask about timing ONCE");
      expect(text).toContain("never repeat a scheduling question they have not had the chance to answer");
    });

    it("stops the AI reporting its own just-made booking as a collision", () => {
      // "It actually looks like that time was already booked for you", to the
      // caller who had just chosen it, that sounds like a stranger took it.
      expect(build()).toContain("Never say the slot was already booked");
    });
  });

  describe("Aug 14 2026: the AI voiced both sides of the call", () => {
    /**
     * HomeLight transfer, call 28f9c228. The transfer dropped the AI into the
     * seller's voicemail. With no human replying, the model filled the silence
     * by SPEAKING the caller's turns itself. One assistant turn, transcribed
     * from the audio it actually played down the line, reads:
     *
     *   "...that's 975 568. Is that correct?user
     *    Correct. I want to sell my house ASAP.Got it, ASAP. And what's the
     *    property address you're thinking of selling?"
     *
     * It emitted the literal role token "user", invented the seller's answer,
     * then answered itself. The 975568 it "caught" was digits off the
     * voicemail system, not anything a person said. It closed by leaving
     * "This lead was for a property at roughly when you want to sell ASAP."
     *
     * Two rules, because two things failed: it did not recognise a recording,
     * and it manufactured the other half of a conversation.
     */
    it("forbids speaking or inventing the caller's side of the call", () => {
      const text = build();
      expect(text).toContain("Never speak the caller's side of the conversation");
      expect(text).toContain("never write out a role label");
      // The specific failure: treating its own invention as something heard.
      expect(text).toContain("Only ever react to words the caller actually said");
    });

    it("teaches the AI to recognise a recording and stop talking to it", () => {
      const text = build();
      expect(text).toContain("recorded system rather than a person");
      // The exact shapes on that call: a connect prompt, then a record menu.
      expect(text).toContain("press one");
      expect(text).toContain("voicemail greeting");
      // Silence is the safe default: never interview a machine.
      expect(text).toContain("do not carry on a conversation with it");
    });

    it("keeps a voicemail message short and never invents lead facts", () => {
      const text = build();
      expect(text).toContain("who you are, which business");
      expect(text).toContain("Never read out lead details");
    });

    it("carves out interpreting, so it cannot fight translator mode", () => {
      // translatorModeCue tells the AI to relay each party "in the FIRST
      // PERSON as whoever you are interpreting". A blanket, persistent "never
      // speak the caller's side" in the system instruction outranks a
      // mid-call coordinator message and would stall or de-voice interpreting
      // on a bridged call both humans can hear (Bugbot, PR #1377).
      //
      // The carve-out keeps the part that actually matters: relaying real
      // words is allowed, inventing them never is.
      const text = build();
      expect(text).toContain("interpreter");
      expect(text).toContain("never invent words nobody said");
    });

    it("gives these rules to staff callers too", () => {
      // The HomeLight transfer line answers as an internal-assistant persona,
      // so a customer-only rule would have missed this exact call.
      const text = build({ callerIdentity: { kind: "owner", name: "Amy Laidlaw" } });
      expect(text).toContain("Never speak the caller's side of the conversation");
      expect(text).toContain("recorded system rather than a person");
    });
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
    // The lead name-ask is customer-only: staff are explicitly never asked.
    expect(text).not.toContain("can I get your name?");
    expect(text).toContain("never ask them for their name");
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
