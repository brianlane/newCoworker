import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { translatorModeCue } from "../vps/voice-bridge/src/system-instruction";

/**
 * Live translator mode: after a warm transfer the AI stays on the bridged call
 * as an interpreter instead of removing its media fork.
 *
 * The cue is the entire behavioral switch (Gemini Live cannot swap a system
 * instruction mid-session), so these tests pin the instructions that keep a
 * receptionist from answering on a caller's behalf while audible to both
 * parties. The source-level assertions below pin the safety wiring in the
 * bridge, which is not directly importable (VPS-only runtime deps).
 */

const BRIDGE = join(__dirname, "../vps/voice-bridge/src/gemini-telnyx-bridge.ts");
const INDEX = join(__dirname, "../vps/voice-bridge/src/index.ts");
const INBOUND = join(__dirname, "../supabase/functions/telnyx-voice-inbound/index.ts");

describe("translatorModeCue", () => {
  it("tells the model both parties can hear it", () => {
    expect(translatorModeCue({})).toContain("Both of them can hear you");
  });

  it("names the languages in each direction when the caller language is known", () => {
    const cue = translatorModeCue({ callerLanguage: "es" });
    expect(cue).toContain("say what they said in English");
    expect(cue).toContain("say what they said in Spanish");
  });

  it("falls back to relative wording when the caller language is unknown", () => {
    const cue = translatorModeCue({});
    expect(cue).toContain("in the colleague's language");
    expect(cue).toContain("in the caller's language");
    expect(cue).not.toContain("in Spanish");
  });

  it("greets the human by name when known", () => {
    expect(translatorModeCue({ humanName: "Dave" })).toContain("(Dave)");
    expect(translatorModeCue({})).not.toContain("()");
  });

  it("forbids answering on anyone's behalf", () => {
    const cue = translatorModeCue({});
    expect(cue).toContain("Never answer a question yourself");
    expect(cue).toContain("never add, explain, soften, summarize, or leave anything out");
  });

  it("requires first-person interpretation, not reported speech", () => {
    const cue = translatorModeCue({});
    expect(cue).toContain("FIRST PERSON");
    expect(cue).toContain("Never say things like he says");
  });

  it("bans every tool and any hangup once interpreting", () => {
    const cue = translatorModeCue({});
    expect(cue).toContain("Do not use any tools from here on");
    expect(cue).toContain("do not book, text, email, look anything up, or end the call");
  });

  it("requires silence between turns rather than filling pauses", () => {
    expect(translatorModeCue({})).toContain("never fill a pause");
  });

  it("discloses itself to the human by default and can be turned off", () => {
    expect(translatorModeCue({ discloseToHuman: true })).toContain(
      "say exactly one short line so your colleague knows you are there"
    );
    expect(translatorModeCue({ discloseToHuman: false })).not.toContain(
      "say exactly one short line"
    );
  });

  it("carries no em dash (repo writing rule)", () => {
    expect(translatorModeCue({ callerLanguage: "es", humanName: "Dave" })).not.toContain("\u2014");
  });
});

describe("the bridge only interprets on a call that was armed at answer time", () => {
  const src = readFileSync(BRIDGE, "utf8");

  it("gates the stay-on branch on the transfer capability's translatorMode flag", () => {
    // An unarmed call's fork reaches only the caller (Telnyx `opposite`
    // default), so staying on would talk over the caller while the human hears
    // nothing. The flag is set from the same tenant column the answer path arms.
    expect(src).toContain("opts.transfer!.translatorMode === true");
  });

  it("falls back to the normal detach when the cue cannot be delivered", () => {
    expect(src).toContain("translator cue failed, detaching");
    // The fallback must clear the flag so the detach branch below still runs.
    expect(src).toMatch(/translatorActive = false;/);
  });

  it("keeps the fork attached by returning before the detach branch", () => {
    // Anchor on the transfer handler, not the tool-refusal branch (which also
    // opens with `if (translatorActive)` and appears earlier in the file).
    const transferBranch = src.slice(src.indexOf("opts.transfer!.translatorMode === true"));
    const stayOn = transferBranch.slice(0, transferBranch.indexOf("// On a SUCCESSFUL warm"));
    expect(stayOn).toContain("scheduleTranslatorCeiling()");
    expect(stayOn).toContain("return;");
    // The detach branch must come AFTER, so a failed cue still falls through it.
    expect(transferBranch).toContain("transferDetachRequested = true;");
  });

  it("suppresses every wind-down cue once interpreting", () => {
    // Three timers (warn, nudge, final teardown) each guard on translatorActive:
    // a "say goodbye now" cue mid-interpretation would be spoken to two humans
    // having their own conversation.
    const guards = src.match(/if \(ended \|\| translatorActive\) return;/g) ?? [];
    expect(guards.length).toBe(3);
  });

  it("keeps the diagnostics heartbeat running while interpreting", () => {
    // Regression guard: an earlier cut called clearTimers() here, which also
    // kills the 15s heartbeat and would make interpreted calls the least
    // observable ones on the fleet.
    const branch = src.slice(
      src.indexOf("translatorActive = true;"),
      src.indexOf("scheduleTranslatorCeiling()")
    );
    expect(branch).not.toContain("clearTimers()");
  });

  it("refuses tool calls while interpreting instead of trusting the prompt alone", () => {
    expect(src).toContain("voice_bridge_translator_tool_refused");
    expect(src).toContain("interpreting: tools are unavailable on this call");
  });

  it("bounds the interpreted stretch with a standalone ceiling timer", () => {
    // Standalone (not in `timers`) so a clearTimers() can never strand an open
    // Live session on an hour-long human conversation.
    const fn = src.slice(src.indexOf("const scheduleTranslatorCeiling"));
    expect(fn.slice(0, 900)).not.toContain("timers.push");
    expect(fn.slice(0, 1200)).toContain("voice_bridge_translator_ceiling_reached");
  });

  it("detaches before teardown at the ceiling so the humans keep talking", () => {
    const fn = src.slice(src.indexOf("const scheduleTranslatorCeiling"));
    const detachAt = fn.indexOf("opts.transfer.detach");
    const teardownAt = fn.indexOf("await teardown()");
    expect(detachAt).toBeGreaterThan(-1);
    expect(teardownAt).toBeGreaterThan(detachAt);
  });
});

describe("arming is off by default and read from the tenant column", () => {
  it("the bridge treats a missing column as off", () => {
    const src = readFileSync(INDEX, "utf8");
    expect(src).toContain("translatorModeEnabled: row?.translator_mode_enabled === true");
  });

  it("the bridge passes the tenant setting into the transfer capability", () => {
    const src = readFileSync(INDEX, "utf8");
    expect(src).toContain("translatorMode: tenantSettings.translatorModeEnabled");
  });

  it("the inbound path arms the answer-time stream only when the tenant opted in", () => {
    const src = readFileSync(INBOUND, "utf8");
    expect(src).toContain("translator_mode_enabled");
    expect(src).toContain('...(translatorArmed ? { targetLegs: "both" as const } : {})');
  });

  it("the migration defaults the column to false", () => {
    const sql = readFileSync(
      join(__dirname, "../supabase/migrations/20260821004000_voice_translator_mode.sql"),
      "utf8"
    );
    expect(sql).toContain("translator_mode_enabled boolean not null default false");
  });
});
