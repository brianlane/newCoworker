import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  systemInstructionForBusiness,
  translatorModeCue
} from "../vps/voice-bridge/src/system-instruction";

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
    const detachAt = fn.indexOf("const detach = opts.detachMedia ?? opts.transfer?.detach;");
    const teardownAt = fn.indexOf("await teardown()");
    expect(detachAt).toBeGreaterThan(-1);
    expect(teardownAt).toBeGreaterThan(detachAt);
  });

  it("can detach without a transfer capability, which the staff path has none of", () => {
    // Regression: the ceiling originally detached only through
    // transfer.detach, so a tenant with no transfer target would close the
    // Gemini session while Telnyx kept streaming to a bridge with no session.
    const fn = src.slice(src.indexOf("const scheduleTranslatorCeiling"));
    expect(fn.slice(0, 1600)).toContain("opts.detachMedia ?? opts.transfer?.detach");
    const idx = readFileSync(INDEX, "utf8");
    // Wired unconditionally on the API key, NOT gated on a transfer target.
    expect(idx).toContain("const detachMedia = detachMediaApiKey");
    expect(idx).toContain("detachMedia,");
  });
});

describe("staff-requested translator mode (they add the other person themselves)", () => {
  const src = readFileSync(BRIDGE, "utf8");
  const decls = readFileSync(
    join(__dirname, "../vps/voice-bridge/src/tool-declarations.ts"),
    "utf8"
  );

  it("frames the other party as someone the colleague is adding", () => {
    const cue = translatorModeCue({ entry: "staff_request", humanName: "Amy" });
    expect(cue).toContain("(Amy)");
    expect(cue).toContain("asked you to interpret");
    expect(cue).toContain("adding someone");
    expect(cue).toContain("Everyone on the call can hear you");
  });

  it("uses the language the staff member named, and still follows what it hears", () => {
    const cue = translatorModeCue({ entry: "staff_request", otherLanguage: "Spanish" });
    expect(cue).toContain("said that person speaks Spanish");
    expect(cue).toContain("Put what your colleague says into Spanish");
    expect(cue).toContain("Follow the languages you actually hear");
  });

  it("degrades to relative wording when no language was named", () => {
    const cue = translatorModeCue({ entry: "staff_request" });
    expect(cue).toContain("the other person's language");
    expect(cue).not.toContain("said that person speaks");
  });

  it("waits through the dialing and hold tones instead of narrating them", () => {
    // The staff member needs a moment to merge the other person in; an
    // interpreter that starts talking over hold music is unusable.
    const cue = translatorModeCue({ entry: "staff_request" });
    expect(cue).toContain("Wait quietly until you hear the other person");
    expect(cue).toContain("never talk over that");
  });

  it("keeps the same relay discipline as the transfer path", () => {
    const cue = translatorModeCue({ entry: "staff_request" });
    expect(cue).toContain("FIRST PERSON");
    expect(cue).toContain("Never answer a question yourself");
    expect(cue).toContain("Do not use any tools from here on");
    expect(cue).toContain("never fill a pause");
  });

  it("carries no em dash (repo writing rule)", () => {
    expect(
      translatorModeCue({ entry: "staff_request", humanName: "Amy", otherLanguage: "Spanish" })
    ).not.toContain("\u2014");
  });

  it("is declared as a voice tool so the registry parity guard is satisfied", () => {
    expect(decls).toContain('name: "start_translator_mode"');
  });

  it("is withheld from customer callers at declaration time", () => {
    // Rides the same STAFF_ONLY_TOOLS gate run_aiflow uses.
    expect(src).toContain('STAFF_ONLY_TOOLS = new Set(["run_aiflow", "start_translator_mode"])');
    expect(src).toContain("if (!callerIsStaff && STAFF_ONLY_TOOLS.has(decl.name)) continue;");
  });

  it("refuses a customer a second time in the handler, not just by omission", () => {
    // Defense in depth: a leaked declaration must not be enough to silence the
    // receptionist for the rest of a stranger's call.
    const handler = src.slice(src.indexOf('if (name === "start_translator_mode")'));
    expect(handler.slice(0, 900)).toContain("voice_bridge_translator_staff_refused");
    expect(handler.slice(0, 900)).toContain(
      "translator mode is only available to the business's own team"
    );
  });

  it("needs no target-legs arming, unlike the post-transfer path", () => {
    // The AI is already audible on the staff member's own leg, so whatever they
    // merge in hears it through that leg. Nothing to arm, nothing to fail open to.
    const handler = src.slice(src.indexOf('if (name === "start_translator_mode")'));
    const body = handler.slice(0, handler.indexOf('if (name === "capture_lead"'));
    // It must not consult the answer-time arming flag the transfer path needs.
    expect(body).not.toContain("transfer!.translatorMode");
    expect(body).not.toContain("translatorModeEnabled");
    expect(body).toContain("scheduleTranslatorCeiling()");
  });

  it("honors the Settings toggle, which a bridge-local tool has no adapter to enforce", async () => {
    // Bugbot: the registry advertises this as configurable, but HTTP-proxied
    // voice tools are gated app-side by agentToolDisabledResponse and a
    // bridge-local tool has no such chokepoint. Without the read below the
    // Settings switch would be decoration.
    expect(src).toContain(
      'if (decl.name === "start_translator_mode" && !opts.translatorOnRequestEnabled) continue;'
    );
    const handler = src.slice(src.indexOf('if (name === "start_translator_mode")'));
    expect(handler.slice(0, 1600)).toContain("voice_bridge_translator_tool_disabled");
    // index.ts resolves it from agent_tool_settings, staff calls only.
    const idx = readFileSync(INDEX, "utf8");
    expect(idx).toContain('toolKey: "start_translator_mode"');
    expect(idx).toContain("translatorOnRequestEnabled");
  });

  it("teaches the tool in the staff prompt only when it was actually declared", () => {
    // Bugbot: with the toggle off the declaration is withheld, so a prompt that
    // still coached the tool would have the model try to call something that
    // does not exist. There is no adapter to answer "tool_disabled" here.
    const staffWith = systemInstructionForBusiness(
      "Acme",
      false,
      true,
      undefined,
      undefined,
      null,
      { kind: "owner", name: "Amy" },
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    const staffWithout = systemInstructionForBusiness(
      "Acme",
      false,
      true,
      undefined,
      undefined,
      null,
      { kind: "owner", name: "Amy" },
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );
    expect(staffWith).toContain("`start_translator_mode`");
    expect(staffWithout).not.toContain("start_translator_mode");
    // Default (omitted) keeps the prompt as it was before the tool existed.
    expect(
      systemInstructionForBusiness("Acme", false, true, undefined, undefined, null, {
        kind: "owner"
      })
    ).not.toContain("start_translator_mode");
    // The bridge derives the flag from the declarations it just built.
    expect(src).toContain('declarations.some((d) => d.name === "start_translator_mode")');
  });

  it("bounds the staff-requested stretch with the same ceiling", () => {
    const handler = src.slice(src.indexOf('if (name === "start_translator_mode")'));
    const body = handler.slice(0, handler.indexOf('if (name === "capture_lead"'));
    expect(body).toContain("scheduleTranslatorCeiling()");
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
