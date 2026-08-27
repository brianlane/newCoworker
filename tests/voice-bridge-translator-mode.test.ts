import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  systemInstructionForBusiness,
  translatorModeCue,
  translatorModeEndCue
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
    expect(translatorModeCue({ callerLanguage: "es" })).toContain("Both of them can hear you");
  });

  it("names the languages in each direction", () => {
    const cue = translatorModeCue({ callerLanguage: "es" });
    expect(cue).toContain("say what they said in English");
    expect(cue).toContain("say what they said in Spanish");
  });

  it("names the COLLEAGUE's language too, rather than assuming English", () => {
    // A Spanish-speaking tenant taking an English caller is the mirror image,
    // and hardcoding English here would have told the model to translate
    // English into English.
    const cue = translatorModeCue({ callerLanguage: "en", colleagueLanguage: "es" });
    expect(cue).toContain("say what they said in Spanish");
    expect(cue).toContain("say what they said in English");
  });

  it("cannot be built without a caller language on the transfer path", () => {
    // The whole Aug 18 defect in one assertion. The relative wording this used
    // to fall back to ("in the caller's language", with no language named) is
    // what let the model invent Spanish for two English speakers. The gate now
    // guarantees a language before the cue is ever built, so the ambiguous
    // phrasing is gone rather than merely unused.
    const cue = translatorModeCue({ callerLanguage: "es" });
    expect(cue).not.toContain("in the caller's language");
    expect(cue).not.toContain("in the colleague's language");
  });

  it("greets the human by name when known", () => {
    expect(translatorModeCue({ callerLanguage: "es", humanName: "Dave" })).toContain("(Dave)");
    expect(translatorModeCue({ callerLanguage: "es" })).not.toContain("()");
  });

  it("forbids answering on anyone's behalf", () => {
    const cue = translatorModeCue({ callerLanguage: "es" });
    expect(cue).toContain("Never answer a question yourself");
    expect(cue).toContain("never add, explain, soften, summarize, or leave anything out");
  });

  it("requires first-person interpretation, not reported speech", () => {
    const cue = translatorModeCue({ callerLanguage: "es" });
    expect(cue).toContain("FIRST PERSON");
    expect(cue).toContain("Never say things like he says");
  });

  it("bans every tool and any hangup once interpreting", () => {
    const cue = translatorModeCue({ callerLanguage: "es" });
    expect(cue).toContain("Do not use any tools from here on");
    expect(cue).toContain("do not book, text, email, look anything up, or end the call");
  });

  it("requires silence between turns rather than filling pauses", () => {
    expect(translatorModeCue({ callerLanguage: "es" })).toContain("never fill a pause");
  });

  it("discloses itself to the human by default and can be turned off", () => {
    expect(translatorModeCue({ callerLanguage: "es", discloseToHuman: true })).toContain(
      "say exactly one short line so your colleague knows you are there"
    );
    expect(translatorModeCue({ callerLanguage: "es", discloseToHuman: false })).not.toContain(
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

  it("ALSO requires a real language difference, not just the tenant flag", () => {
    // The Aug 18 defect (call 5634b7f0): being armed was the only condition, so
    // every warm transfer on an armed tenant became an interpreted call. The
    // arming check answers "can the human hear us"; this one answers "does
    // anybody need an interpreter", and both have to pass.
    const branch = src.slice(src.indexOf("opts.transfer!.translatorMode === true"));
    const stayOn = branch.slice(0, branch.indexOf("// On a SUCCESSFUL warm"));
    expect(stayOn).toContain("resolveInterpretDecision");
    expect(stayOn).toContain("interpret.engage");
  });

  it("records why it declined, so a skipped interpretation is diagnosable", () => {
    expect(src).toContain("voice_bridge_translator_mode_skipped");
    const branch = src.slice(src.indexOf("voice_bridge_translator_mode_skipped"));
    expect(branch.slice(0, 400)).toContain("reason: interpret.reason");
  });

  it("passes the DECIDED languages to the cue, never a null one", () => {
    // Reading the stored preference straight into the cue is what produced
    // `caller_language: null` on the incident call.
    const branch = src.slice(src.indexOf("opts.transfer!.translatorMode === true"));
    const stayOn = branch.slice(0, branch.indexOf("// On a SUCCESSFUL warm"));
    const cueCall = stayOn.slice(
      stayOn.indexOf("translatorModeCue({"),
      stayOn.indexOf("emitDiag(\"voice_bridge_translator_mode_entered\"")
    );
    expect(cueCall).toContain("callerLanguage: interpret.callerLanguage");
    expect(cueCall).toContain("colleagueLanguage: interpret.colleagueLanguage");
    // The stored preference is an INPUT to the decision, never the value the
    // cue is built from. Feeding it straight through is what produced
    // `caller_language: null` on the incident call.
    expect(cueCall).not.toContain("languagePrefs");
  });

  it("declining leaves the call on today's detach path", () => {
    // A declined interpretation must be indistinguishable from translator mode
    // never having existed: the AI leaves and the two humans talk privately.
    const branch = src.slice(src.indexOf("opts.transfer!.translatorMode === true"));
    const stayOn = branch.slice(0, branch.indexOf("// On a SUCCESSFUL warm"));
    const declineAt = stayOn.indexOf("voice_bridge_translator_mode_skipped");
    const activateAt = stayOn.indexOf("translatorActive = true;");
    expect(declineAt).toBeGreaterThan(-1);
    expect(activateAt).toBeGreaterThan(declineAt);
  });

  it("feeds the gate what the caller actually said on this call", () => {
    // Stored preference alone would deny the interpreter to every first-time
    // Spanish caller, which is the case the feature was built for.
    expect(src).toContain("createCallerSpeechLog");
    expect(src).toContain("callerSpeech.ingest(");
    const branch = src.slice(src.indexOf("opts.transfer!.translatorMode === true"));
    expect(branch.slice(0, branch.indexOf("// On a SUCCESSFUL warm"))).toContain(
      "callerTurns: callerSpeech.turns()"
    );
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

  it("treats a REPEAT start_translator_mode as an idempotent success, not an error", () => {
    // Observed live: the model called start_translator_mode three times in
    // ~600ms. Answering the repeats with the generic tool-refusal error had it
    // re-announce its readiness twice to the staff member. Asking to start
    // something already running is a no-op, so confirm the state instead.
    const guard = src.slice(src.indexOf("if (translatorActive) {"));
    const body = guard.slice(0, guard.indexOf("voice_bridge_translator_tool_refused"));
    expect(body).toContain('if (name === "start_translator_mode")');
    expect(body).toContain("voice_bridge_translator_already_active");
    expect(body).toContain('detail: "already interpreting"');
    expect(body).toContain("ok: true");
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
    // Named in STAFF_ONLY_TOOLS alongside run_aiflow, and registered only under
    // the callerIsStaff branch below, so a customer never sees the declaration.
    expect(src).toContain('"start_translator_mode",\n    "stop_translator_mode"');
    expect(src).toContain(
      "if (!intake && callerIsStaff && opts.translatorOnRequestEnabled) {"
    );
  });

  it("does not depend on the HTTP voice-tools proxy being configured", () => {
    // Bugbot: it was registered inside the `voiceToolsReady` loop with the
    // PROXIED tools, so a box missing APP_BASE_URL or the gateway token lost a
    // tool that needs neither. Bridge-local tools follow transfer_to_owner and
    // end_call instead, which are declared outside that gate.
    expect(src).toContain(
      'BRIDGE_LOCAL_TOOLS = new Set(["start_translator_mode", "stop_translator_mode"])'
    );
    expect(src).toContain("if (BRIDGE_LOCAL_TOOLS.has(decl.name)) continue;");
    // The registration block must sit OUTSIDE the voiceToolsReady loop.
    const loopAt = src.indexOf("if (!intake && voiceToolsReady) {");
    const bridgeLocalAt = src.indexOf(
      "if (!intake && callerIsStaff && opts.translatorOnRequestEnabled) {"
    );
    expect(bridgeLocalAt).toBeGreaterThan(loopAt);
    const between = src.slice(loopAt, bridgeLocalAt);
    // The loop closes before the bridge-local block opens.
    expect(between).toContain("declarations.push(decl);");
  });

  it("refuses a customer a second time in the handler, not just by omission", () => {
    // Defense in depth: a leaked declaration must not be enough to silence the
    // receptionist for the rest of a stranger's call.
    const handler = src.slice(src.indexOf('if (name === "start_translator_mode") {\n        // STAFF ONLY'));
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
      "if (!intake && callerIsStaff && opts.translatorOnRequestEnabled) {"
    );
    const handler = src.slice(
      src.indexOf('if (name === "start_translator_mode") {\n        // STAFF ONLY')
    );
    const body = handler.slice(0, handler.indexOf('if (name === "capture_lead"'));
    expect(body).toContain("voice_bridge_translator_tool_disabled");
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

describe("interpreting can END, so staff get their assistant back", () => {
  const src = readFileSync(BRIDGE, "utf8");
  const decls = readFileSync(
    join(__dirname, "../vps/voice-bridge/src/tool-declarations.ts"),
    "utf8"
  );

  it("carves the exit out of 'interpret everything', which otherwise traps the call", () => {
    // Observed live: the colleague said "they just hung up, thanks for helping
    // me" and it was translated into Spanish for a customer who had already
    // left, because the cue says to interpret even questions aimed at the AI.
    const cue = translatorModeCue({ entry: "staff_request" });
    expect(cue).toContain("ONE exception to interpreting everything");
    expect(cue).toContain("`stop_translator_mode`");
    expect(cue).toContain("If you are not sure, keep interpreting");
  });

  it("only honors the exit from the colleague, not the other party", () => {
    const cue = translatorModeCue({ entry: "staff_request" });
    expect(cue).toContain("Only when your colleague says it");
    expect(decls).toContain('name: "stop_translator_mode"');
    expect(decls).toContain("Never call it because the OTHER person said something like that");
  });

  it("hands the session back to the assistant persona", () => {
    const end = translatorModeEndCue({ humanName: "Brian" });
    expect(end).toContain("Interpreting is finished, Brian");
    expect(end).toContain("your tools work again");
    expect(end).toContain("Do not translate anything else");
    expect(end).not.toContain("\u2014");
  });

  it("declares the exit up front, because Live cannot add tools mid-session", () => {
    expect(src).toContain(
      'decl.name === "start_translator_mode" || decl.name === "stop_translator_mode"'
    );
    expect(src).toContain('BRIDGE_LOCAL_TOOLS = new Set(["start_translator_mode", "stop_translator_mode"])');
  });

  it("lets the exit through the blanket tool refusal", () => {
    const guard = src.slice(src.indexOf("if (translatorActive) {"));
    const body = guard.slice(0, guard.indexOf("voice_bridge_translator_tool_refused"));
    expect(body).toContain('if (name === "stop_translator_mode")');
  });

  it("refuses the exit on a TRANSFER, where a customer is bridged in", () => {
    // Dropping back to receptionist behavior mid-conversation would strand a
    // customer who never asked for it.
    const guard = src.slice(src.indexOf('if (name === "stop_translator_mode")'));
    expect(guard.slice(0, 900)).toContain('translatorEntry !== "staff_request"');
    expect(guard.slice(0, 900)).toContain("voice_bridge_translator_stop_refused");
  });

  it("cancels the interpreter ceiling on exit so it cannot tear down a normal call", () => {
    const stop = src.slice(src.indexOf('if (name === "stop_translator_mode") {\n          if ('));
    const body = stop.slice(0, stop.indexOf("emitDiag(\"voice_bridge_translator_mode_exited\""));
    expect(body).toContain("clearTimeout(translatorCeilingTimer)");
    // Belt and braces: the ceiling itself also re-checks the flag at fire time.
    const ceiling = src.slice(src.indexOf("const scheduleTranslatorCeiling"));
    expect(ceiling.slice(0, ceiling.indexOf("void (async () => {"))).toContain(
      "if (ended || !translatorActive) return;"
    );
  });

  it("treats a stop request when not interpreting as a no-op", () => {
    expect(src).toContain('detail: "not interpreting"');
  });

  it("records how interpreting began at both entry points", () => {
    expect(src).toContain('translatorEntry = "staff_request"');
    expect(src).toContain('translatorEntry = "transfer"');
  });

  it("sends the handback cue BEFORE flipping state, mirroring the entry path", () => {
    // Clearing the flags first and then throwing on the cue would report a
    // handback that never happened: the model keeps interpreting while the
    // ceiling that bounded it is already cancelled.
    const stop = src.slice(src.indexOf('if (name === "stop_translator_mode") {\n          if ('));
    const body = stop.slice(0, stop.indexOf("emitDiag(\"voice_bridge_translator_mode_exited\""));
    const cueAt = body.indexOf("translatorModeEndCue");
    const clearAt = body.indexOf("translatorActive = false");
    expect(cueAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(cueAt);
    // And a failed cue keeps interpreting rather than reporting success.
    expect(body).toContain("could not stop interpreting");
  });

  it("re-arms the session cap on exit, since both bounds are otherwise gone", () => {
    // The one-shot sessionMaxMs teardown returns early while interpreting, so
    // it is consumed. Exiting also cancels the interpreter ceiling, which would
    // leave an assistant-mode call with no cap and open Live billing.
    expect(src).toContain("sessionCapDeferredByTranslator = true");
    expect(src).toContain("function scheduleSessionCapTeardown(");
    const stop = src.slice(src.indexOf('if (name === "stop_translator_mode") {\n          if ('));
    const body = stop.slice(0, stop.indexOf("emitDiag(\"voice_bridge_translator_mode_exited\""));
    expect(body).toContain("if (sessionCapDeferredByTranslator) {");
    expect(body).toContain("timers.push(scheduleSessionCapTeardown(capMs))");
    // Whatever is left of the original budget, else a short grace.
    expect(body).toContain("remainingMs > 0 ? remainingMs : TRANSLATOR_EXIT_GRACE_MS");
  });

  it("the ceiling claims the end synchronously, before any await", () => {
    // clearTimeout cannot stop a callback already running. Without a claim, an
    // exit landing during the detach would leave the call detached (no audio)
    // and never torn down.
    const ceiling = src.slice(src.indexOf("const scheduleTranslatorCeiling"));
    const head = ceiling.slice(0, ceiling.indexOf("void (async () => {"));
    expect(head).toContain("if (ended || !translatorActive) return;");
    expect(head).toContain("translatorActive = false;");
    expect(head).toContain("translatorCeilingTimer = null;");
  });
});

describe("arming is off by default and read from the tenant column", () => {
  it("the bridge treats a missing column as off and ANDs the Standard+ tier gate", () => {
    const src = readFileSync(INDEX, "utf8");
    expect(src).toContain(
      "translatorModeEnabled: row?.translator_mode_enabled === true && translatorTierOk"
    );
  });

  it("the STAFF-REQUEST path carries the tier conjunct (the G1 fix, #1085)", () => {
    // #1028 gated only the post-transfer path; the staff-request translator
    // was a separate flag on a separate path, and a Starter owner could run
    // full-duplex Gemini Live interpretation with the session cap deferred.
    // #1085 added this conjunct as a one-line fix WITH NO TEST: deleting
    // `tenantSettings.translatorTierAllowed &&` left every suite green,
    // and neither the root tsc nor the bridge's own tsc would object. This
    // pin is what makes that deletion red.
    const idx = readFileSync(INDEX, "utf8");
    expect(idx).toContain(
      "const translatorOnRequestEnabled = callerIsStaff && tenantSettings.translatorTierAllowed"
    );
    // And the flag it reads is fed from the tier predicate, not from a
    // settings row.
    expect(idx).toContain("translatorTierAllowed: translatorTierOk");
  });

  it("the bridge's hand-copied tier predicate matches the canonical one", () => {
    // vps/voice-bridge cannot import supabase/functions/_shared (its own
    // package, bundled for the box), so index.ts re-implements the predicate
    // inline. That lockstep copy is WHY the staff-request flag was missed in
    // the first place (#1085's root cause). Derive the expected expression
    // from the canonical module so a change there forces the copy to move
    // in the same PR.
    const canonical = readFileSync(
      join(__dirname, "../supabase/functions/_shared/translator_tier.ts"),
      "utf8"
    );
    const expr = /return (.+);/.exec(canonical)?.[1];
    expect(expr).toBeTruthy();
    const idx = readFileSync(INDEX, "utf8");
    expect(idx).toContain(`const translatorTierOk = ${expr};`);
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

  it("shipped opt-in, then flipped to default ON once the echo risk was cleared", () => {
    // The original migration created the column default false, because arming
    // sends target_legs=both on EVERY call and we could not yet prove that was
    // inert on an ordinary one-party call. Verified on HQ 2026-07-25, so the
    // follow-up flips the default and arms existing tenants.
    const original = readFileSync(
      join(__dirname, "../supabase/migrations/20260821004000_voice_translator_mode.sql"),
      "utf8"
    );
    expect(original).toContain("translator_mode_enabled boolean not null default false");
    const flip = readFileSync(
      join(__dirname, "../supabase/migrations/20260821006000_translator_mode_default_on.sql"),
      "utf8"
    );
    expect(flip).toContain("alter column translator_mode_enabled set default true");
    expect(flip).toContain("set translator_mode_enabled = true");
  });
});

describe("an interpreted call is marked as one, for the owner reading it back", () => {
  const src = readFileSync(BRIDGE, "utf8");

  it("stamps the transcript from BOTH entry paths", () => {
    // Whoever a colleague merges in on the staff path arrives on the same
    // undiarized stream, so that transcript is exactly as ambiguous.
    const marks = src.match(/void transcriptRecorder\?\.markInterpreting\(\);/g) ?? [];
    expect(marks.length).toBe(2);
  });

  it("stamps it only once interpreting is actually committed", () => {
    // A mark written before the gate ran would claim an interpreted call on
    // every transfer, which is the labelling half of the same defect.
    const branch = src.slice(src.indexOf("opts.transfer!.translatorMode === true"));
    const stayOn = branch.slice(0, branch.indexOf("// On a SUCCESSFUL warm"));
    const skipAt = stayOn.indexOf("voice_bridge_translator_mode_skipped");
    const markAt = stayOn.indexOf("markInterpreting()");
    expect(markAt).toBeGreaterThan(skipAt);
  });

  it("writes the column the call view reads", () => {
    expect(readFileSync(INDEX, "utf8")).toContain("interpreted_from_turn_index:");
  });
});
