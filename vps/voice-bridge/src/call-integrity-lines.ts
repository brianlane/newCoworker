/**
 * Two prompt rules that every voice persona needs, kept in ONE place because
 * the bridge builds its system instruction in two entirely separate functions
 * and the incident that produced these rules ran through the one that would
 * have been missed.
 *
 * `systemInstructionForBusiness` (system-instruction.ts) builds the
 * receptionist and staff personas. `intakeSystemInstruction` (intake.ts)
 * builds the AI-takeover persona used for live seller transfers and outbound
 * calls. The bridge picks between them at session setup. A rule added to only
 * one silently does not exist on the other half of the fleet's calls.
 *
 * THE INCIDENT (HomeLight transfer, 2026-08-14, call 28f9c228). The transfer
 * dropped the AI into the seller's voicemail. Nobody replied, and the model
 * filled the silence by SPEAKING the caller's turns itself. One turn it
 * played down the line, transcribed from its own audio, ran:
 *
 *   "...that's 975 568. Is that correct?user
 *    Correct. I want to sell my house ASAP.Got it, ASAP. And what's the
 *    property address you're thinking of selling?"
 *
 * It emitted the literal role token, invented the seller's answer, then
 * answered its own question. The digits came off the voicemail system's menu.
 * The intake persona tells the AI its first priority is a callback number and
 * to read it back to confirm, which is exactly the instruction those menu
 * digits satisfied.
 */

/**
 * One voice, and only real words.
 *
 * The role-label ban and the invented-turn ban matter well beyond voicemail:
 * a model that manufactures the other party is putting words in a real
 * seller's mouth on a live call, and then acting on them.
 *
 * The interpreter clause is load-bearing, not a hedge. `translatorModeCue`
 * puts the session into interpreting, where relaying a party's words in the
 * first person IS the job ("if they say they need to reschedule, you say I
 * need to reschedule"). A blanket persistent NEVER in the system instruction
 * outranks a mid-call coordinator message, so without the carve-out this rule
 * would stall interpreting or push it back into the assistant voice on a
 * bridged call both humans can hear. What survives the carve-out is the part
 * that actually failed: relaying real words is allowed, inventing them is not.
 */
export const ONE_VOICE_LINE =
  "You speak ONLY as yourself, one turn at a time. Never speak the caller's side of the conversation, never write out a role label such as \"user\" or \"assistant\", and never continue past your own turn to supply their answer. If the line is silent, wait or ask a short question, and say nothing else: silence is never permission to imagine a reply. Only ever react to words the caller actually said on this call, and if you did not hear something clearly, ask them to repeat it rather than deciding what it must have been. The one exception is when a coordinator message puts you into interpreter mode: relaying what a real person actually said, in their voice, is then your job, but even there you never invent words nobody said.";

/**
 * Recordings are not people.
 *
 * Names the shapes present on the incident call (a keypad menu, then a
 * record-a-message menu) rather than the abstraction, because the model had
 * already proven it would answer a menu as if a person had asked. The
 * no-details rule on the voicemail itself comes from what it actually left:
 * "This lead was for a property at roughly when you want to sell ASAP."
 *
 * The keypress carve-out is not a softening, it is what keeps HomeLight
 * working. That partner answers into an automated announcement and the
 * referral is WON by pressing a digit on a timer: the bridge arms an
 * `ivrGate`, registers `press_digits`, and cues the model to stay silent and
 * press. This rule is persistent and therefore outranks that mid-call cue, so
 * a flat "never answer a recording's prompts" would make the model sit
 * through the announcement and lose the referral outright, which is a worse
 * failure than the one this line exists to prevent. Pressing a key was never
 * the problem; talking to a machine and mining it for facts was, and both of
 * those stay banned.
 *
 * Voicemail policy is deferred rather than stated, for the same
 * precedence reason. The platform already owns it: a `place_ai_call` step
 * leaves a message only when the author set `voicemailTemplate`, and without
 * one the AI hangs up (outcome reason `voicemail_no_message`, on the grounds
 * that talking to a recording wastes minutes). An unconditional "at the beep,
 * leave one short message" here would outrule that and have every unscripted
 * call improvising voicemails at customers in copy nobody approved. So this
 * line shapes the message when there IS one and otherwise says stay silent.
 */
export const RECORDED_SYSTEM_LINE =
  "Recordings are not people. If what you hear is a recorded system rather than a person (a menu offering keypad options like \"press one\", hold music, a ringback, an automated greeting, or a voicemail greeting inviting you to leave a message), do not carry on a conversation with it, do not talk back to it, and never treat digits or words it reads out as something the caller told you. Working a keypad menu is the exception and stays your job: when a coordinator message has told you to press a key (for example to accept a referral or to be connected), press it the moment the recording asks, silently and without commentary. Pressing a key is not talking to it. Otherwise say nothing until a person speaks. If you reach a beep and your instructions include a message to leave, leave that ONE message and stop: who you are, which business you are calling from, why you called in one sentence, and how to reach you. If you were not given a message to leave, do not improvise one: stay silent and let the call end. Never read out lead details, prices, addresses, timelines, or anything from your briefing into a voicemail, and never leave a message that repeats a template or trails off unfinished.";
