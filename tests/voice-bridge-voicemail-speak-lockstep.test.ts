import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VOICEMAIL_SPEAK_VOICE as EDGE_VOICE,
  type VoicemailSpeakTrigger
} from "../supabase/functions/_shared/voice_voicemail_speak.ts";
import { VOICEMAIL_SPEAK_VOICE as BRIDGE_VOICE } from "../vps/voice-bridge/src/voicemail-speak";
import { MACHINE_PHRASES as EDGE_PHRASES } from "../supabase/functions/_shared/call_integrity.ts";
import {
  MACHINE_PHRASES as BRIDGE_PHRASES,
  looksMachineGenerated as bridgeLooks
} from "../vps/voice-bridge/src/machine-phrases";
import { looksMachineGenerated as edgeLooks } from "../supabase/functions/_shared/call_integrity.ts";

const ROOT = join(__dirname, "..");
const EDGE_SPEAK = readFileSync(
  join(ROOT, "supabase/functions/_shared/voice_voicemail_speak.ts"),
  "utf8"
);
const BRIDGE_SPEAK = readFileSync(join(ROOT, "vps/voice-bridge/src/voicemail-speak.ts"), "utf8");
const EDGE_TELNYX = readFileSync(
  join(ROOT, "supabase/functions/_shared/telnyx_call_actions.ts"),
  "utf8"
);
const BRIDGE_TELNYX = readFileSync(join(ROOT, "vps/voice-bridge/src/telnyx-call-actions.ts"), "utf8");

const TRIGGERS: VoicemailSpeakTrigger[] = ["beep", "sweep", "bridge_beep", "cancelled_retry"];

describe("voicemail speak lockstep (bridge vs edge)", () => {
  it("uses the same Telnyx voice", () => {
    expect(BRIDGE_VOICE).toBe(EDGE_VOICE);
    expect(BRIDGE_VOICE).toBe("female");
  });

  it("pins the claim RPCs, patch keys, and trigger names", () => {
    for (const needle of [
      "voice_claim_voicemail_speak",
      "voice_release_voicemail_claim",
      "voice_session_context_merge",
      "voicemail_speak_started_at",
      "voicemail_speak_script_chars",
      "voicemail_speak_trigger",
      "voicemail_speak_restarted",
      "bridge_beep",
      "cancelled_retry"
    ]) {
      expect(EDGE_SPEAK, needle).toContain(needle);
      expect(BRIDGE_SPEAK, needle).toContain(needle);
    }
    for (const trigger of TRIGGERS) {
      expect(EDGE_SPEAK).toContain(`"${trigger}"`);
      expect(BRIDGE_SPEAK).toContain(`"${trigger}"`);
    }
  });

  it("posts the same /actions/speak body shape", () => {
    for (const src of [EDGE_TELNYX, BRIDGE_TELNYX]) {
      expect(src).toContain("actions/speak");
      expect(src).toContain("payload: text");
      expect(src).toContain("voice");
      expect(src).toContain("language");
    }
  });
});

describe("machine-phrase lockstep (bridge vs sweep)", () => {
  it("the phrase list is identical, including order", () => {
    expect([...BRIDGE_PHRASES]).toEqual([...EDGE_PHRASES]);
  });

  it("looksMachineGenerated agrees on the menus and on ordinary speech", () => {
    const corpus = [
      "Press one to be connected to the client",
      "Please leave a message after the tone",
      "say hi AT THE BEEP",
      "Hi, I want to sell my house in Mesa.",
      ""
    ];
    for (const line of corpus) {
      expect(bridgeLooks(line), line).toBe(edgeLooks(line));
    }
  });
});
