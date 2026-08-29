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
 * The exception is scoped per ANNOUNCEMENT, not per press, because both
 * directions are real failures.
 *
 * Re-pressing the same announcement has to stay allowed: a Telnyx OK is not
 * proof the partner accepted, so an early blind fallback can land before the
 * menu is listening while the partner keeps looping "press 1".
 * `ivr-gate-press.ts` permits up to IVR_MAX_ACCEPT_PRESSES with a cooldown,
 * and the post-accept cue tells the model to press again if the recording is
 * still asking. A "spent once you have pressed" rule would outrank that cue
 * and lose the referral on an early first tone.
 *
 * Pressing into a DIFFERENT recording is the failure to stop, because the cue
 * stays in the session after the accept. The incident call shows the shape:
 * the seller's mailbox offered "Replay your message. Press one. To continue
 * recording, press two." That is the partner gate's DTMF aimed at a
 * stranger's voicemail.
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
  "Recordings are not people. If what you hear is a recorded system rather than a person (a menu offering keypad options like \"press one\", hold music, a ringback, an automated greeting, or a voicemail greeting inviting you to leave a message), do not carry on a conversation with it, do not talk back to it, and never treat digits or words it reads out as something the caller told you. Working a keypad menu is the exception and stays your job: when a coordinator message has told you to press a key (for example to accept a referral or to be connected), press it the moment that announcement asks, silently and without commentary. Pressing a key is not talking to it. That exception covers only the announcement the coordinator named: if that same announcement is still asking, press again, but once the call has moved on to a different recording (a voicemail menu offering to replay or re-record your message, for instance), do not press anything. Otherwise say nothing until a person speaks. If you reach a beep and your instructions include a message to leave, leave that ONE message and stop, saying only what that message says: who you are, which business you are calling from, and why you called in one sentence. Give a callback number ONLY if one is written in the message you were given, and then only those digits. If you were not given a message to leave, do not improvise one: stay silent and let the call end. Never read out lead details, prices, addresses, timelines, or anything from your briefing into a voicemail, and never leave a message that repeats a template or trails off unfinished.";

/**
 * Never say a contact detail you were not given.
 *
 * Amy Laidlaw, 2026-08-25, about her own AI: "whose phone number is this? I
 * thought they usually put the AI phone number in there." Her coworker had
 * told lead Tami Nelson to call back on 480-256-2580, which is not her line
 * (602-695-1142), not her AI line, not a teammate's, and appears in no flow,
 * config or contact row. Over the previous 45 days it invented THIRTEEN
 * distinct numbers, one per voicemail, all plausible live Phoenix numbers, so
 * strangers were fielding her leads' callbacks.
 *
 * The authored scripts were never wrong: every one carries 602-695-1142, and
 * the rendered script was present on the session for every call checked. Two
 * things combined instead.
 *
 * First, at the beep the model ad-libs a polite sign-off BEFORE calling
 * `voicemail_reached` to fetch that script, so at the moment it speaks it
 * holds no number. Second, and this is the part that made fabrication feel
 * mandatory, RECORDED_SYSTEM_LINE told it the message should say "how to
 * reach you" without ever handing it a number to say. Asked for a callback
 * number it did not have, it produced one. That clause is now conditional on
 * the script actually containing one; this line closes the general case.
 *
 * Scoped to CONTACT DETAILS rather than all digits on purpose: prices,
 * timeframes, and keypad digits are all legitimate and frequent. It is the
 * details a person will ACT on, by dialling or writing to them, that are
 * unrecoverable when wrong.
 *
 * The rule is framed as SOURCE, not as silence, and both permitted sources
 * are load-bearing (Bugbot, PR #1612). A first draft banned any detail not in
 * the written materials and carved out only "repeating digits back", which
 * broke two jobs the personas are explicitly given:
 *
 *  - intake COLLECTS a property address and an email and confirms them as it
 *    goes, and neither is digits, so the model could have refused to read
 *    back what the caller had just said;
 *  - interpreter mode relays what a real person said, in their voice, which
 *    is exactly how a bridged bilingual call passes an address or a number
 *    between two humans. ONE_VOICE_LINE above carries the same carve-out for
 *    the same reason: a persistent NEVER outranks a mid-call coordinator cue,
 *    so a blanket ban here would have silently gutted translator calls.
 *
 * So a detail may be spoken when it came from the written materials OR from
 * the person on this call. Fabrication is precisely the case where it came
 * from neither.
 *
 * Lives here rather than in intake.ts because the receptionist persona takes
 * inbound callers who ask "what is your number?" just as often, and the whole
 * point of this module is that a rule added to one builder silently does not
 * exist on the other half of the fleet's calls.
 */
export const NO_INVENTED_CONTACT_LINE =
  "NEVER invent a contact detail. A phone number, email address, website, or street address may only leave your mouth if it is written, character for character, in your instructions, your briefing, or a script you were given for this call, OR if the person on this call just told it to you and you are repeating it back so they can confirm you heard it right. Those are the only two sources. Do not reconstruct one from memory, do not adapt one you have seen before, and never assemble a plausible local number: a detail you make up reaches a stranger, and the person you are speaking to will dial it or write to it. If someone asks how to reach the business, or you are ending a message and want to leave a way back, and none was given to you, give none. Say that the office will follow up, or say nothing at all. In interpreter mode the same rule holds in the relaying direction: pass on exactly the details a real person actually said, and never fill in one they did not.";

/**
 * Never state a money figure you were not given.
 *
 * THE INCIDENT (Clever seller lead, 2026-08-20, call 60a64ddd). Calling Luis
 * Castillo about 6826 W Pierson St, the AI said: "Clever offered you a cash
 * offer program, and the offers on your file are 375k and 395k." The only
 * offers ever sent for that lead were $320,097, $342,000 and $325,000, and
 * they arrived four minutes AFTER the call ended. At the moment it spoke, the
 * AI held one referral text reading "Est. home value: $425,000.00" and no
 * offers at all. Both figures were invented, both were tens of thousands
 * high, and it delivered them to the seller as a fact about their own file.
 *
 * This is the case NO_INVENTED_CONTACT_LINE deliberately left out. That rule
 * scoped itself to details "a person will ACT on, by dialling or writing to
 * them", reasoning that "prices, timeframes, and keypad digits are all
 * legitimate and frequent". The first half of that still holds and is why
 * this line is narrow. The second half does not survive this call: a seller
 * acts on a number like that by deciding whether to list, and unlike a wrong
 * phone number, which fails visibly the moment somebody dials it, a wrong
 * price is never contradicted by anything.
 *
 * So this bans ATTRIBUTED figures only, the ones asserted as coming from our
 * records, a partner, or the person's file. Ordinary priced conversation is
 * untouched on purpose: a receptionist quoting the shop's own rates, an agent
 * talking about what homes in an area are going for, or repeating back a
 * number the caller just said all stay allowed, and a rule broad enough to
 * catch those would be a rule the personas cannot follow.
 *
 * Like every rule in this module it is paired with detection rather than
 * trusted: `invented_amount` in supabase/functions/_shared/call_integrity.ts
 * reports these daily off real transcripts. #1612 proved a prompt rule alone
 * does not close this class, and that lesson is why the sweep shipped with
 * this line rather than after it.
 */
export const NO_INVENTED_FIGURE_LINE =
  "NEVER invent a money figure. If you present an amount as coming from our records, from a partner or referral service, from an offer, or from the person's own file, that exact amount must be written in your instructions, your briefing, or a script you were given for this call, or the person on this call must have just told it to you. If you were not given the figures, say so plainly and offer to follow up with them: say that you do not have the numbers in front of you, never a guess, never a range you assembled yourself, and never a placeholder that sounds close. This covers only amounts you attribute to a source. Talking about prices in general, quoting rates you were given, and repeating back a number the person just said are all still your job.";
