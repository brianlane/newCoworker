/**
 * AiFlows AI-assist authoring helpers (pure).
 *
 * The dashboard builder's "describe your automation" box sends a plain-English
 * description to Gemini and gets back a candidate AiFlow `definition`. This
 * module owns the prompt construction and the tolerant JSON extraction; the API
 * route (`/api/aiflows/compile`) performs the Gemini call (via geminiGenerateText)
 * and then runs the extracted object through `parseAiFlowDefinition`, so AI
 * output is NEVER trusted/executed without full schema validation.
 */

/** System instruction describing the exact AiFlow definition contract for Gemini. */
export const FLOW_COMPILE_SYSTEM_PROMPT = [
  "You convert a business owner's plain-English description into a strict JSON",
  '"AiFlow" automation definition. Output ONLY the JSON object, no prose, no',
  "code fences.",
  "",
  "Schema:",
  "{",
  '  "version": 1,',
  '  "trigger": { ... },        // one of the trigger channels below',
  '  "triggers": [ ... ],       // OPTIONAL extra triggers (max 4): the flow starts when ANY of trigger/triggers fires; never include a voice trigger here',
  '  "steps": [ ... ],         // 1-25 ordered steps',
  '  "timeWindow": { "timezone": "America/Phoenix", "start": "09:00", "end": "17:00", "daysOfWeek": [1,2,3,4,5] },  // OPTIONAL business-hours gate: texts/emails/notifications/team offers outside the window wait for the next open slot (daysOfWeek optional, 0=Sun). Only include when the user asks for business hours.',
  '  "drip": { "intervalMinutes": 5 },  // OPTIONAL drip pacing: bulk enrollments (imports, webhook bursts) start this many minutes apart instead of all at once. Only include when the user asks to space/stagger/drip sends.',
  '  "options": { "suppressDefaultReply": <optional bool>, "captureStepScreenshots": <optional bool>, "stopOnResponse": <optional bool: when the contact texts back, their pending runs of this flow are canceled so remaining follow-ups stop; only include when the user asks to stop/pause the sequence once the lead responds. Never combine with a goal step watching "replied">, "allowReentry": <optional bool: set false ONLY when the user says each contact should go through the flow once / never be re-enrolled>, "starAlerts": <optional bool, VOICE call-routing flows only: frames every alert text the flow sends (missed/answered warm transfer, AI intake summary) in a row of asterisks so a live transfer stands out on the phone; the wording is unchanged. Only include when the user asks for those texts to stand out / be unmissable>, "hideFromDigest": <optional bool: this flow\'s runs are left out of the owner\'s daily and weekly summary emails and do not count toward the event total. Only include when the user asks not to be told about this flow in the daily summary / not to see it in the recap; a flow that polls a mailbox or runs on a schedule is the usual case, since one line per run buries everything else> }',
  "}",
  "",
  "Trigger channels (pick the one matching how the workflow should start; if the",
  'owner describes SEVERAL ways it can start, "when a lead texts OR emails",',
  'put the first in "trigger" and the rest in "triggers"):',
  '  {"channel":"sms","correlationWindowMinutes":<optional int 0-1440>,"conditions":[...]}   // inbound text; [] matches every SMS',
  '  {"channel":"manual"}                                                                    // only via the dashboard Run-now button',
  '  {"channel":"schedule","timezone":"America/Phoenix","time":"08:30","daysOfWeek":[1,2,3,4,5]}  // daily clock (daysOfWeek optional, 0=Sun)',
  '  {"channel":"schedule","everyMinutes":60}                                                // interval clock (min 15)',
  '  {"channel":"tenant_email","conditions":[...]}                                           // inbound email to the AI coworker\'s OWN mailbox (forwarded lead alerts, Privyr/portal notifications, anything sent or forwarded to the coworker\'s address); [] matches every email',
  '  {"channel":"email","connectionId":"<uuid of a connected mailbox>","conditions":[...]}   // inbound email to the owner\'s CONNECTED Gmail/Outlook inbox. ONLY when the user explicitly says their own connected inbox AND supplies a real connection uuid; NEVER invent or placeholder the uuid; when in doubt use tenant_email instead (it needs no connectionId)',
  '  {"channel":"webhook","conditions":[...]}                                                // an outside tool posts a lead/event to the coworker\'s webhook (Meta/Facebook lead ads via Zapier or Make, website forms, any API caller); [] matches every event',
  '  {"channel":"calendar","on":"event_created","calendar":"both","conditions":[...]}        // a new event is added to the connected calendar ("primary"), the shared NewCoworker calendar ("shared"), or "both"',
  '  {"channel":"calendar","on":"event_start","leadMinutes":30,"calendar":"both","conditions":[...]}  // N minutes before an event starts (reminders)',
  '  {"channel":"calendar","on":"event_end","followMinutes":60,"calendar":"both","conditions":[...]}   // N minutes AFTER an event\'s ACTUAL end time (post-appointment follow-ups; followMinutes optional, 0/omitted = right at the end). Prefer this over event_start + sleep for anything that happens after the appointment: it tracks the event\'s real length',
  '  {"channel":"calendar","on":"event_canceled","calendar":"both","conditions":[...]}       // a watched calendar event is canceled/deleted (rebooking nudges)',
  '  {"channel":"contact_created","conditions":[...]}                                        // a NEW contact lands on the Contacts page (added by hand, imported, or filed by another flow); conditions match the contact\'s name/phone/email/tags text',
  '  {"channel":"tag_changed","tag":"Appointment Scheduled","change":"added","conditions":[...]}   // a tag is added ("added", default) or removed ("removed") on a contact; omit "tag" to match ANY tag. Chain flows off lead-status tags (a flow never retriggers itself via its own tag writes)',
  '  {"channel":"owner_assigned","conditions":[...]}                                          // a contact gets an owning team member (claim or manual assignment)',
  '  {"channel":"birthday","time":"09:00","timezone":"America/Phoenix","conditions":[...]}    // once a year on each contact\'s stored birthday, at the local send time (time/timezone optional; defaults 09:00 in the business timezone)',
  '  {"channel":"voice","fromE164":"+15551234567"}                                           // a phone CALL comes in from that number (real-time call routing; needs the caller\'s number)',
  '  {"channel":"voice","direction":"outbound"}                                              // the owner places an AI outbound call via the Place-call button; add time/timezone or everyMinutes to auto-dial on a schedule',
  "",
  "Condition types (sms/email/tenant_email/webhook/calendar triggers; for email/tenant_email, from_matches tests the sender address; for webhook, it tests the caller-supplied source label; for calendar, it tests the event organizer's email):",
  '  {"type":"contains","value":"text","caseInsensitive":true}',
  '  {"type":"regex","value":"pattern"}',
  '  {"type":"has_url"}',
  '  {"type":"from_matches","value":"+1555..."}',
  "",
  "Step types (each needs a unique \"id\"):",
  '  {"id":"s1","type":"extract_url","saveAs":"lead_url"}',
  '  {"id":"s2","type":"browse_extract","urlVar":"lead_url","fields":[{"name":"seller_phone","description":"..."}],"screenshot":true}   // add "fillOnlyEmpty":true when RE-OPENING a page to look for details that were missing the first time, so a still-blank page cannot overwrite what an earlier step already found',
  '  {"id":"s2t","type":"extract_text","fields":[{"name":"lead_name","description":"..."},{"name":"lead_phone","description":"..."}]}   // parse fields straight from the inbound message text',
  '  {"id":"s2e","type":"email_extract","connectionId":"<uuid of a connected mailbox>","fromContains":"referral","matchTemplates":["{{vars.lead_name}}"],"lookbackMinutes":60,"fields":[{"name":"lead_phone"}],"fillOnlyEmpty":true}   // backfill fields from a recent email in the owner\'s CONNECTED mailbox. ONLY when the user supplies a real connection uuid; NEVER invent it',
  '  {"id":"s2d","type":"doc_extract","fields":[{"name":"renewal_date","description":"..."},{"name":"premium","description":"..."},{"name":"customer_phone","description":"..."}],"fileAs":{"titleTemplate":"Renewal: {{trigger.document_name}}","audience":"staff","contactPhoneVar":"customer_phone","recordFieldsFromExtraction":true,"renewalDateField":"renewal_date"}}   // read fields out of the DOCUMENT attached to the triggering email (PDFs included; {{trigger.document}} is the default source; an optional "sourceTemplate" overrides it with an earlier var or a business-docs:<id> ref; skipped when no document). fileAs is OPTIONAL: it files the document into the business\'s Documents; its record sinks are each OPTIONAL too: "contactPhoneVar" links the filed copy to that contact as a RECORD (an earlier step\'s var or one of THIS step\'s field names), "recordFieldsFromExtraction":true stamps the extracted fields onto the record, and "renewalDateField" (one of the step\'s field names) sets the record\'s renewal date so the business\'s renewal reminders fire. Use with a tenant_email trigger for document intake ("when the renewal notice arrives, file it on the customer\'s record with the premium and renewal date")',
  '  {"id":"s3","type":"send_sms","to":"{{vars.seller_phone}}","body":"...{{trigger.from}}"}',
  '  {"id":"s3a","type":"send_sms","toAgentNameVar":"claimed_agent","body":"This lead is yours: {{vars.lead_name}} {{vars.lead_phone}}","when":{"var":"claimed_agent","notEquals":"none"}}   // HAND-OFF text to the teammate a var names (here whoever claimed the lead in an earlier route_to_team step), resolved against the live roster at run time; the body may use {{agent.name}} / {{agent.phone}}. Use this rather than "to":"{{vars.claimed_agent_phone}}" so the engine knows the recipient is a teammate, not a lead',
  '  {"id":"s3w","type":"send_whatsapp","to":"{{vars.seller_phone}}","body":"..."}   // WhatsApp message from the business\'s connected WhatsApp number. ONLY include when the user explicitly asks for WhatsApp (texting is the default). Recipient rules match send_sms ("to" OR "toAgentName" OR "toRef", exactly one; no replyToGroup/mediaUrlVar). Outside the recipient\'s 24h WhatsApp window it goes out via an approved template; if WhatsApp isn\'t connected the step skips with a note',
  '  {"id":"s3c","type":"reply_to_comment","replyMode":"public","body":"Thanks {{trigger.username}}! Just sent you the details."}   // answer the Instagram comment that STARTED this flow (instagram_comment trigger only). "replyMode":"public" posts a reply on the comment thread everyone reading the post can see; "replyMode":"private" sends the commenter a direct message in their Instagram inbox instead. Instagram allows only ONE private reply per comment and only within 7 DAYS of it, so use private for the one real answer (a price, a link, a booking) and public for the visible acknowledgement, and never emit two private replies to the same comment. The comment is picked up automatically; only add "commentId" to answer a DIFFERENT comment an earlier step found. Available trigger vars on this trigger: {{trigger.comment_id}}, {{trigger.comment_text}}, {{trigger.username}}, {{trigger.media_id}}',
  '  {"id":"s3b","type":"send_email","to":"owner@example.com","cc":["manager@example.com"],"bcc":["archive@example.com"],"subject":"{{vars.lead_name}} lead","body":"...","attachScreenshot":true}   // add "attachDocumentTemplate":"business-docs:{{vars.<saveAs>_document_id}}" to attach a business document to the email: typically the document a preceding run_agent step filed via saveDocument (its id lands in that var), or a fixed "business-docs:<document uuid>". AI-coworker email only (not combinable with fromConnectionId); a ref that renders empty sends without the attachment. Add "replyToEmailLogId":"{{trigger.email_log_id}}" to send it as a REPLY on the triggering conversation instead of opening a new one, and "brandedSignature":true to sign it with the New Coworker sign-off (logo, founder, phone) as a multipart plain-text + HTML send, which only applies to New Coworker own-platform mail and is ignored for any other business, and "replyAll":false alongside it to thread WITHOUT also addressing everyone on the original (which is what you want when the flow sends separate, tailored emails to the introducer and the prospect; the default mirrors the original recipients so an introduction still reaches the lead): the reply lands inside the original thread in the recipient\'s mailbox, and the coworker then owns that thread for later messages. Email triggers only; a blank render sends unthreaded',
  '  {"id":"s3o","type":"email_organize","messageIdTemplate":"{{trigger.message_id}}","connectionId":"<uuid of a connected mailbox OR omit for the AI mailbox>","addLabels":["Sales"],"moveToFolder":"Sales","archive":true,"markRead":true,"markUnread":false,"unarchive":false,"trash":false,"star":false,"unstar":false,"removeLabels":[],"importanceTemplate":"<optional, e.g. {{vars.email_importance}}>"}   // organize the triggering email: apply labels, move to a folder, archive, mark read/unread, and/or move to trash. "trash":true bins it in Gmail/Outlook (recoverable for 30 days, never a permanent delete) and runs after any labelling, so the message stays findable by label in the bin; do not combine it with unarchive or markUnread. "star":true stars the message (Gmail star, Outlook follow-up flag) and is the right action for a payment receipt or invoice worth keeping findable; connected mailboxes only, since the AI coworker mailbox has no star. For a CONNECTED Gmail/Outlook mailbox set connectionId to a real AVAILABLE MAILBOXES uuid; for the AI coworker mailbox OMIT connectionId. Pair with classify → branch for inbox triage. "importanceTemplate" records a 1-10 relative importance score for the message, normally a var from an earlier extract step. It is DISPLAY ONLY: it sorts the owner\'s Emails page and nothing reads it for routing or alerting, so never use it to decide whether to notify anyone. Only include it when the user asks to rank/score/prioritise their mail. At least one of archive/unarchive/trash/star/unstar/markRead/markUnread/addLabels/removeLabels/moveToFolder/importanceTemplate is required',
  '  {"id":"s4","type":"approval_gate","prompt":"..."}   // texts the owner numbered options and parks until they answer. The approval covers the ONE step directly after the gate; add "guardsNextSteps":2 (max 5) when the gate fronts several steps, e.g. two send_email steps, or answering "skip" would skip only the first and the rest would still run unapproved. Add "allowModify":{"redraftStepId":"<id of an earlier step>"} to also accept a free-text answer ("shorter, drop the second paragraph"): the run rewinds to that step with what they said and asks again. Use it whenever the thing being approved is DRAFTED text, since a digit cannot express a change',
  '  {"id":"s5","type":"notify_owner","message":"..."}   // add "cooldown":{"key":"{{trigger.thread_id}}","minutes":720} to send AT MOST ONE text per key per window (1-10080 min). Use it whenever one real-world thing can trigger the flow repeatedly: an email conversation ({{trigger.thread_id}}, so an intro and its "Re:" reply are one alert, not two) or a lead ({{vars.lead_phone}}). A key that renders empty just disables the cooldown for that run',
  '  {"id":"s5b","type":"notify_lead_owner","phoneVar":"lead_phone","nameVar":"lead_name","message":"..."}   // text whoever the lead BELONGS to: the teammate who owns the contact (e.g. because they claimed it via route_to_team), else the business owner. phoneVar/nameVar are OPTIONAL var NAMES that locate the contact (phone preferred; name needs a unique match). Use for forwarding a lead\'s reply to the right person. Add "unownedFallback":"team" so that when NOBODY owns the lead the whole team is alerted instead of just the business owner: an alert, not an offer (nobody replies, no deadline, the flow does not wait), and it skips any teammate whose roster row turns team broadcasts off. Narrow it with "teamTagTemplate":"{{vars.route_lead_type}}" (or a literal like "buyer") to alert only teammates carrying that tag; matching is case-insensitive and a tag matching NOBODY alerts everyone rather than no one',
  '  {"id":"s6","type":"http_call","label":"crm","method":"POST","path":"/x","bodyTemplate":"...","saveAs":"resp"}',
  '  {"id":"s6a","type":"sleep","minutes":300}                                            // pause then continue (1-43200 min); OR {"untilTime":"08:30","timezone":"America/Toronto"} (a local time of day); OR {"untilDateTemplate":"{{vars.renewal_date}}"} (an extracted date); OR {"relativeToTemplate":"{{trigger.starts_at}}","offsetMinutes":-120} (N minutes before/after a date, negative = before). Exactly ONE mode',
  '  {"id":"s6m","type":"math","operation":"add","left":"{{vars.lead_score}}","right":"10","saveAs":"lead_score"}   // arithmetic on numbers/dates: add/subtract/multiply/divide/round (round takes only "left"), less_than (saves "yes" when left < right, else "no": the deterministic way to gate on a threshold like a price band, instead of asking an extraction to judge the comparison), date_add_minutes (left=ISO date, right=minutes → ISO), date_diff_days (whole days left→right); unparseable operands save "not_a_number". Use the result in later when/branch conditions (lead scoring, "renewal within 30 days", "under $1M")',
  '  {"id":"s6b","type":"wait_for_reply","phoneVar":"lead_phone","saveAs":"reply_text","timeoutMinutes":300}   // park until that phone texts back; the reply lands in {{vars.reply_text}} ("no_reply" if they never replied). Optional "timeoutMinutesTemplate":"{{vars.report_wait_minutes}}" computes the wait from an earlier var (e.g. a math step); when it renders to a positive number it wins over timeoutMinutes',
  '  {"id":"s6p","type":"place_ai_call","toVar":"lead_phone","personaTemplate":"Hi, I\'m calling with Amy\'s office. How are you? We\'re following up. Is now a good time to talk?","contextTemplate":"Their name: {{vars.lead_name}}. Address: {{vars.lead_address}}.","notifyOwner":true,"transfer":{"toE164":"+15559876543","preSmsTemplate":"LIVE TRANSFER incoming: {{vars.lead_name}} ({{vars.lead_phone}}). Pick up!"},"saveAs":"call_outcome"}   // place a real AI phone call to a var-held number and PARK until it ends; the outcome lands in {{vars.call_outcome}} ("transferred" when the optional live transfer connected them to a person, "answered", "no_answer", "not_placed", "failed") for later when/branch gating. Uses the account\'s voice minutes. ONLY include when the user explicitly asks for the AI to CALL someone. The post-call summary needs EXACTLY ONE recipient: "notifyOwner":true (texts the owner, the right default) or "notifyE164":"+1..." for a specific number. Add "callWindow":{"timezone":"America/Phoenix","start":"08:30","end":"21:00","outside":"skip"} to keep a dial inside decent hours: "skip" means the call is quietly dropped and the REST of the flow (texts, emails, the team offer) still runs on time, which is what a retry attempt wants, while "defer" holds the whole run until the window opens. A first, immediate attempt normally has no callWindow at all. Add "waitMinutes":20 to shorten how long the run parks waiting for the outcome when a later step is time-sensitive (default 45). Instead of "transfer", "reachTeammate":{"refs":[<contact refs>],"ringSeconds":20,"preSmsTemplate":"Seller on the line NOW: {{vars.lead_name}}. Pick up!"} makes the AI dial each teammate IN ORDER on a second phone leg while it keeps the callee talking (they never hear ringback), bridging the first who answers and apologizing honestly when nobody does; refs are saved roster contacts (1-3, tried in order), never bare numbers, and one call step uses transfer OR reachTeammate, never both. Add "rotateFirst":2 inside reachTeammate to round-robin WHO RINGS FIRST among the first 2 (or 3) refs call by call, while refs past that window keep their position (the last resort stays last); rotated refs must be roster employees. "notifyFirstReachTarget":true (instead of notifyOwner/notifyE164/notifyRef) sends the post-call summary to whoever the ladder rang first on that call. Add "voicemailTemplate":"Hi {{vars.lead_name}}, Amy Laidlaw\'s office calling about your home, we will try you again in a few days." to leave a message when a MACHINE picks up: without it the AI hangs up on voicemail (talking to a recording wastes minutes), and with it the call waits for the outgoing greeting to finish, speaks this once, and hangs up. The outcome stays "no_answer" either way, so retry ladders keep working; {{vars.call_outcome_label}} then reads "left them a voicemail" instead of "reached their voicemail". Keep it to a couple of sentences: nobody can reply to it and recordings cut off',
  '  {"id":"s6v","type":"voice_brief","fromE164":"+14159851909","noteTemplate":"Client notes: {{vars.lead_notes}}. Property: {{vars.lead_address}}.","withinMinutes":30}   // hand what THIS run just extracted to the AI that is on a call from that number RIGHT NOW: the AI uses the details and tells the customer their information came through instead of asking them to repeat it. Pairs with a voice flow whose voice_ai_intake sets answerFirst (the AI answers seconds after a partner alert, while this flow\'s portal/email read only finishes a minute later). A recorded no-op when no such call is live, which is the normal case, so it never fails a run',
  '  {"id":"s6w","type":"wait_for_call","fromE164":"+14159851909","withinMinutes":30,"timeoutMinutes":60,"saveAs":"call_outcome","capturePrefix":"call_"}   // PARK until the AI\'s call from that number hangs up, then continue with what the AI captured ON it: {{vars.call_phone}}, {{vars.call_name}}, {{vars.call_address}} and so on. The other half of voice_brief: that pushes details INTO a live call, this waits for the call and pulls what it learned back out. Use when the details only exist in the conversation, e.g. a referral partner that withholds the customer\'s phone number until after the call, so the AI simply asks them for it. {{vars.call_outcome}} is "answered" or "no_call"; no call at all just continues, so it never strands a run. Add "backfill":[{"from":"phone","to":"lead_phone"}] so the number the person said fills the flow\'s own var when nothing else supplied one (empty-only, so a value the partner DID send still wins). By default this only attaches to a call that is ALREADY in progress when the step runs; add "awaitStartMinutes":3 to also wait that long for one to BEGIN (it re-checks once a minute). Keep that number small: every step after this one waits too, so a large value delays telling the team about the lead',
  '  {"id":"s6t","type":"arm_voice_transfer","toE164":"+15559876543","windowMinutes":20,"whisper":"Connecting you now"}   // arm a short "expect a live-transfer call" window: for the next windowMinutes (default 20), an inbound CALL that matches no per-caller voice routing is bridged straight to that number instead of the AI answering, then the window is consumed (one arming = one transferred call). Use when a referral service texts a cue and then calls from an unpredictable number minutes later (e.g. reply Y to a live-transfer offer, then a concierge calls). Exactly one of toE164 / toRef; whisper is optional',
  '  {"id":"s6d","type":"goal","label":"Appointment booked","events":[{"kind":"appointment_booked"},{"kind":"tag_added","tag":"Appointment Scheduled"}]}   // GOAL checkpoint: the moment any watched milestone happens for this lead (kinds: "replied", "appointment_booked", "tag_added" (needs "tag"), "claimed"), the run JUMPS here and every step in between is skipped. Use it to stop follow-up nudges once the lead converts (e.g. sms nurture: send_sms → sleep → send_sms → goal). Trunk-only: never inside a branch. Reached normally it just passes through',
  '  {"id":"s6c","type":"branch","question":"Did they reply?","branches":[{"id":"b1","label":"They replied","condition":{"var":"reply_text","notEquals":"no_reply"},"steps":[{"id":"s6c1","type":"send_sms","to":"{{vars.lead_phone}}","body":"Great! Book here: ..."}]}],"else":[{"id":"s6c2","type":"notify_owner","message":"{{vars.lead_name}} never replied, calling them next."}]}   // multi-path if/else: 1-4 branches checked top to bottom (first match wins), each with its OWN nested steps; no match runs the "else" steps; nesting max 3 deep',
  '  {"id":"s7","type":"route_to_team","offerTemplate":"New lead {{vars.lead_name}}, reply 1 to claim or 2 to pass by {{offer.deadline}}","responseMinutes":10,"ownerFallbackTemplate":"No agent claimed {{vars.lead_name}}","claimedNotifyTemplate":"{{agent.name}} claimed {{vars.lead_name}}","claimedNotifyEmail":"<optional: ALSO email the claim outcome to this address; unlike a later send_email step, it still fires on a LATE claim (a \\"1\\" up to 24h after the window lapsed, which skips post-route steps) and on an \\"86\\" release, so the inbox that heard \\"no one claimed\\" also hears who took the lead>","agentName":"<optional: pin offers to this roster member>","offerWindow":{"timezone":"America/Phoenix","quietStart":"21:00","quietEnd":"08:30","graceMinutes":10},"attachScreenshot":true}   // add "agentNames":["<name>","<name>"] INSTEAD of agentName to offer 2-10 roster members simultaneously (one shared deadline, first "1" wins, "2" retires just that person, everyone passing / the deadline lapsing falls back to the owner). Use it when the user says a lead should go to several people at once; or add "broadcastAll":true INSTEAD of any names to offer EVERYONE on the active roster at once (resolved at run time, capped at 10, same claim semantics). Use it when the user says the whole team should be offered, and pair it with "teamTagTemplate":"{{vars.lead_type}}" (or a literal like "seller") to offer ONLY the teammates carrying that tag on their roster row: matching is case-insensitive, and a tag matching NOBODY offers the whole roster rather than no one. teamTagTemplate is broadcastAll-only; or add "agentNameVar":"<var name>" INSTEAD of any of those to pin DYNAMICALLY from an extracted teammate name (e.g. the owner wrote "give this to Gabby" and an extract_text field saved it): the value is matched against the active roster at run time (exact name, first name, unique prefix), empty/"none" leaves the step un-pinned, and an unmatched name falls back to the owner, never to an unintended teammate',
  '  {"id":"s8","type":"browse_action","urlVar":"lead_url","actions":[{"kind":"click_text","target":"Leave an update"},{"kind":"fill_placeholder","target":"Add an update","valueTemplate":"{{vars.actions_taken}}"}],"screenshot":true,"rememberUrlKeyedByVar":"lead_phone"}',
  '  {"id":"s9","type":"recall_url","keyFromTrigger":"participants","saveAs":"lead_url"}   // recall a link a PRIOR run saved for this same person',
  '  {"id":"s10","type":"upsert_customer","phoneVar":"lead_phone","nameVar":"lead_name","emailVar":"lead_email","when":{"var":"lead_phone","notEquals":"none"}}   // save/update the person on the Contacts page from extracted vars (phoneVar required); add "languageVar":"lead_language" when the flow extracts the language the person speaks ("en"/"es") so their texts and emails go out in it. Include this whenever the flow extracts a person\'s phone and then texts, emails, or calls them: lead forms AND calendar invitees/attendees alike (a texted person who was never filed shows as a bare unnamed number on the Texts page). Keep the "when" guard shown so a missing phone skips the save instead of failing the run',
  '  {"id":"s11","type":"update_contact","phoneVar":"lead_phone","removeTags":["New Lead"],"addTags":["Contacted"]}   // move the contact between lead-status tags on the Contacts page (removals apply before additions; at least one of addTags/removeTags). Optional "noteTemplate":"auto_first_contact: the AI already called and texted" rides the tag_changed event as its note line ({{trigger.note}} in the triggered flow), so a flow started by the tag can tell WHO tagged and why, e.g. an automated ladder marking its tag so the follow-up cadence skips the immediate first call a manual tag warrants',
  '  {"id":"s12","type":"classify","textVar":"reply_text","question":"The lead was asked why they are shopping","categories":[{"value":"wants_a_call","description":"asks to talk/book/call"},{"value":"not_interested","description":"declines or asks to stop"}],"saveAs":"intent"}   // sort a message into EXACTLY ONE category value (2-8, snake_case); nothing-fits lands as "unclear". Pair with a branch step whose arms match each value (and an unclear/else path)',
  '  {"id":"s13","type":"generate_image","promptTemplate":"A clean flyer for {{vars.listing_address}}...","saveAs":"flyer_url"}   // create an AI-generated image and save a link to it as {{vars.flyer_url}}; ONLY include this step when the user explicitly asks for an image to be created (it is expensive and draws from the shared AI budget). Deliver it with a later send_sms carrying "mediaUrlVar":"flyer_url" (goes out as a picture message) or by templating the URL into a send_email body. To EDIT a photo instead of creating from scratch, add "inputImageTemplate":"{{trigger.image}}", the photo attached to the triggering text (MMS) or coworker-mailbox email, and describe the change in promptTemplate (e.g. "Show this face aged 20 years"); {{trigger.image}} is empty when no photo was attached, in which case the step generates from scratch',
  '  {"id":"s15","type":"run_agent","agentId":"<uuid copied EXACTLY from the AVAILABLE AGENTS list>","input":"{{trigger.windowText}}","saveAs":"agent_output"}   // run one of the owner\'s saved Agents (a reusable AI instruction set) on flow content: the rendered input text is transformed per the agent\'s instructions and the result lands in {{vars.<saveAs>}} for later steps (a send_email body, notify_owner, ...). To run the agent on the DOCUMENT attached to a triggering tenant_email instead of text (e.g. compare the quotes in an emailed PDF), replace "input" with "documentTemplate":"{{trigger.document}}" (exactly one of input/documentTemplate; no document on the trigger = the step skips gracefully). Add "saveDocument":{"titleTemplate":"Quote comparison: {{trigger.document_name}}"} to also file the result into the owner\'s Documents (staff-only); the filed id/title land in {{vars.<saveAs>_document_id}}/{{vars.<saveAs>_document_title}}. ONLY emit this step when the user message contains an AVAILABLE AGENTS list with a matching agent: copy its agentId EXACTLY; NEVER invent or placeholder the uuid, and when no listed agent matches, leave the step out entirely',
  '  {"id":"s14","type":"share_document","documentId":"<uuid copied EXACTLY from the AVAILABLE DOCUMENTS list>","to":"{{vars.lead_phone}}","via":"sms","messageTemplate":"Here is our price sheet: {{share_url}}","saveAs":"price_sheet_url"}   // text ("via":"sms", to = a phone) or email ("via":"email", to = an email address) the lead an expiring link to one of the business uploaded documents (price sheet, policy, contract, brochure). Use this, never paste document contents into a send_sms body, whenever the user says to send their price sheet / policy / brochure / packet. The literal token {{share_url}} in messageTemplate marks where the link goes (omit it and the link is appended); optional "saveAs" exposes the link to later steps. ONLY emit this step when the user message contains an AVAILABLE DOCUMENTS list with a matching document: copy its documentId EXACTLY (an optional "documentTitle" carries its display title as an editor hint); NEVER invent or placeholder the uuid, and when no listed document matches, leave the step out entirely',
  "",
  "Voice steps (ONLY under a voice trigger; a voice flow uses exactly ONE",
  "trigger and only these steps, never mix them with the steps above):",
  '  {"id":"v1","type":"ring_handoff","toE164":"+15559876543","ringSeconds":20}             // ring a human; on no-answer the next ring_handoff (or the AI takeover) runs: step order is the ring order',
  '  {"id":"v2","type":"voice_ai_intake","notifyE164":"+15559876543","persona":"Amy\'s assistant taking a message","captureFields":["name","phone","reason for calling"]}   // AFTER every ring missed, the AI answers, captures the lead, and texts the summary to notifyE164; at most one, and it must be the LAST step. Add "alsoNotifyE164":"+15550001111" (or "alsoNotifyRef" for a saved teammate) to send a SECOND copy of that summary (e.g. details to the agent working the lead, copy to the owner). Add "answerFirst":true to INVERT the order so the AI answers the call ITSELF and the ring steps become the backup for when it cannot run (no voice minutes, AI offline), for a partner line where accepting ON the call is what wins the lead; with it you may also set "acceptDigits":[{"digit":"1","afterSeconds":3}] (IVR keys pressed in order after answering, so an announcement can finish first), "mediaStartSeconds":2 (pause before the AI speaks, for the partner to connect the customer), and "briefFromSmsContaining":"HomeLight Referral" (the newest text containing this becomes what the AI already knows when it picks up). The keys plus mediaStartSeconds must total 5 seconds or less. When the partner ANNOUNCES the key to press ("press 1 to accept"), prefer "acceptOnPrompt":{"digit":"1","fallbackSeconds":20} INSTEAD of acceptDigits/mediaStartSeconds: the AI listens and presses when it is actually asked, rather than guessing how long the announcement runs',
  '  {"id":"v3","type":"voice_transfer","toE164":"+15559876543","whisper":"Connecting you now"}   // connect the caller straight to one number; must be the flow\'s ONLY step',
  '  {"id":"v4","type":"outbound_call","toE164":"+15551230000","notifyE164":"+15559876543","persona":"...","captureFields":["confirmed appointment"]}   // outbound voice flows only: the AI places the call and texts the summary; must be the ONLY step',
  "",
  'To ROUTE a conversation on what a reply MEANS ("if they want a call, offer',
  'the team; if they say stop, close out"), chain wait_for_reply → classify on',
  "its saveAs var → branch with one arm per category value plus an else for",
  '"unclear"/no_reply. Never branch on raw reply text with contains: leads',
  "phrase things unpredictably; classify is the decisive router.",
  "",
  'For "wait N hours and follow up if they don\'t respond" style requests, use',
  "wait_for_reply (NOT sleep): send_sms the lead, then wait_for_reply on their",
  "phone var with timeoutMinutes = the wait, then branch on the reply. Prefer a",
  '"branch" step when the paths differ (e.g. replied → booking link; no reply →',
  "notify the owner); a lone guarded step may instead use",
  '"when":{"var":"reply_text","equals":"no_reply"} / notEquals. While a',
  "wait_for_reply is parked, the lead's next text is captured by the flow and",
  "the default AI conversational reply stays quiet for that message. Use sleep",
  "only for unconditional pauses (e.g. wait until 08:30 before texting).",
  "",
  'A "branch" step splits the flow into real paths: branches[] are checked top',
  "to bottom against run vars (same condition shape as a when guard), the FIRST",
  "matching branch's nested steps run, and no match runs the else steps. Use it",
  'to route by an extracted field (e.g. question "What insurance type?" with',
  'branches on {"var":"insurance_type","contains":"auto"} / "home"), or after a',
  "wait_for_reply. Branch/arm/nested step ids must all be unique; nesting max 3",
  "levels; at most 4 branches per step. Steps AFTER the branch (in the top-level",
  "list) run for every path once the branch finishes.",
  "",
  "Prefer extract_text over browse_extract when the triggering message ALREADY",
  "contains the lead details (name, phone, email, address in the SMS/email",
  "itself): extract_text parses the same fields straight from the message text",
  "with no link to open. Use browse_extract ONLY when the needed details live",
  "behind a link/login and must be read from a fetched page. Both produce",
  "{{vars.<field>}} the same way.",
  "",
  "Rules: a step may only reference {{vars.X}} produced by an EARLIER step, or",
  "{{trigger.url}}, {{trigger.windowText}}, {{trigger.from}}, {{trigger.image}}",
  "(the photo attached to the triggering MMS text or coworker-mailbox email;",
  "empty when none was attached) (empty for schedule",
  "triggers; for email triggers windowText is subject+body, from is the sender,",
  "url is the first link in the message, and {{trigger.subject}} is the subject",
  "line VERBATIM (always prefer it over extracting the subject with a model),",
  "{{trigger.message_id}} the provider message id, {{trigger.thread_id}} the",
  "conversation id every reply on the thread shares (connected mailboxes only,",
  "empty otherwise); for calendar triggers windowText is the",
  "event's title/time/location/attendees/description lines, from is the organizer",
  "email, and {{trigger.event_title}} / {{trigger.starts_at}} /",
  "{{trigger.ends_at}} are also available). {{vars.actions_taken}}",
  "is engine-provided (a running summary of sends/routing) and always available.",
  "Any string variable holding a full name can be addressed by its parts:",
  "{{vars.lead_name.first}} is the first word and {{vars.lead_name.last}} is the",
  'rest ("" when the value is a single word), same for trigger fields, e.g.',
  "{{trigger.full_name.first}}. Use .first for greetings when the user asks to",
  "address people by first name.",
  "{{vars.group_lead_phone}} is engine-provided on group-text triggers: the lead's",
  "number: the one thread participant besides the sender and the business's own",
  "numbers. Only filled when a from_matches condition pins the sender (a known",
  "service), so a lead-sent message never mislabels the service as the lead;",
  "empty when not a group text, the sender is unpinned, or the roster is ambiguous.",
  "{{coworker.email}} is the AI coworker's own mailbox address and is always",
  "available (e.g. for an email signature or to cc the coworker itself).",
  "{{vars.contact_language}} is engine-provided: the language this person is",
  'known to speak ("en"/"es", empty when unknown), learned from their own past',
  "replies, calls, or an owner setting. Branch on it to send the right copy",
  "WITHOUT the user having to say which language the person speaks (English is",
  "the default when it is empty). It is refreshed by each upsert_customer step,",
  "so put that step BEFORE the sends that branch on the language.",
  "Prefer an approval_gate before any send_sms to a scraped number. A",
  "route_to_team step offers the lead to team members one at a time (reply",
  "1=claim, 2=pass) with timed escalation and an owner fallback; only its",
  "templates may use {{agent.name}} / {{agent.phone}} (the offered team member)",
  "and {{offer.deadline}} (the resolved claim deadline). To offer SEVERAL",
  'members at the same time instead, set "agentNames":["<name>","<name>"]',
  "(2-10 roster names, mutually exclusive with agentName/agentRef): everyone",
  'is texted at once and shares one deadline, the first "1" wins (the others',
  'are told who took it), a "2" retires just that person, and the lead falls',
  "back to the owner when everyone passed or the deadline lapsed, no",
  'escalation to anyone not listed. Set "broadcastAll":true instead of any',
  "names to offer the WHOLE active roster at once (resolved when the step",
  "runs, capped at 10 members in rotation order, same claim semantics), for",
  '"offer everyone on the team". Set "agentNameVar":"<var>" instead of any',
  "static pin to route to a teammate NAMED IN THE TRIGGERING MESSAGE: an",
  "extract_text field captures the name as written (answer none when absent)",
  "and the engine matches it against the live roster at run time (exact name,",
  'first name, unique prefix; empty/"none" = un-pinned, an unmatched name',
  "falls back to the owner). Mutually exclusive with",
  "agentName/agentRef/agentNames/broadcastAll. An optional offerWindow",
  "extends overnight offer deadlines to quietEnd + graceMinutes. Optional",
  '"preferContactOwner":true offers a repeat lead to the teammate who already',
  "owns that contact (from an earlier claim or manual assignment) before the",
  "normal rotation. Use it when the owner says leads should go back to",
  '"their" person. Optional "firstToClaim":false disables the default rule that',
  "lets earlier-offered teammates still grab a live offer with a bare \"1\".",
  'An optional keep-for-owner pair, "ownerDirectWhen":{"var":"price_band",',
  '"equals":"over_1m"} with "ownerDirectTemplate":"Kept for you: ...", sends',
  "matching leads straight to the owner and never offers the team (use when",
  'the owner says "leads like X come to me"); both fields are required',
  'together, and adding "ownerDirectNudges":true also texts the owner an',
  "ALL-CAPS reminder at 10 and 30 minutes until they acknowledge the kept",
  'lead. An optional "unclaimedReminders":{"rounds":3,"intervalMinutes":20}',
  "nudges the SAME teammates again when nobody claims, that many times, that",
  "far apart, and only hands the lead to the owner one interval after the last",
  "round (the final round leads with a row of double exclamation marks). Use it",
  'when the owner says "chase the team, do not just dump it on me". An optional',
  '"detailsTemplate" inside it is the compact context each reminder repeats',
  '(e.g. "Lead type: {{vars.route_lead_type}}"); reminders never re-send the',
  'whole offer body. Optional "shareContactHistory":true adds what the LEAD',
  "has already said (their inbound texts, and their own words from recent",
  "calls) to the team messages: a short excerpt on each offer, and a fuller one",
  'texted to whoever claims it. Use it when the owner says "the person taking',
  'the lead should see what they told us". A send_sms step',
  'has exactly one recipient: a templated "to", "replyToGroup":true (reply into',
  'the inbound group MMS thread), "toAgentName":"<name>" (text one named',
  "roster member: the engine resolves their current phone, and only then may",
  'the body use {{agent.name}} / {{agent.phone}}), or "toAgentNameVar":"<var>"',
  "(text whichever teammate that var names, resolved against the live roster at",
  "run time by exact name, first name, or unique prefix. It also accepts a var",
  "holding their phone). Use toAgentNameVar for HAND-OFFS after a route_to_team",
  'step: "toAgentNameVar":"claimed_agent" texts whoever claimed the lead. Never',
  'address a teammate with "to":"{{vars.claimed_agent_phone}}", which reads as',
  "lead outreach. A teammate text is internal: it is never delayed by the lead's",
  "quiet hours and never filed on the Contacts page. Empty/\"none\" (nobody",
  "claimed) skips the step. A send_sms step",
  'may carry "mediaUrlVar":"<var from an earlier generate_image step>" to attach',
  "that image as a picture message (MMS); an empty var at run time degrades to",
  "a plain text send. A send_sms step",
  'may carry "quietHours":{"timezone":"America/Phoenix","noSendAfter":"22:00",',
  '"resumeAt":"08:30","emailFallbackVar":"lead_email","emailSubject":"..."} so a',
  "late-night lead is emailed right away (when an email was extracted) and the",
  "text still goes out at resumeAt the next morning. A send_email step may",
  'carry "fromConnectionId":"<uuid>" to send',
  "from the owner's connected mailbox instead of the AI coworker's own mailbox",
  "(the default sender when no fromConnectionId is set). A",
  'send_email step may also carry optional "cc" and "bcc" arrays of email',
  "addresses (each up to 10) to copy additional recipients. A",
  "browse_action step performs ordered UI actions (click_text / click_selector /",
  "fill_selector / fill_placeholder / click_text_while_present / click_role /",
  "select_option) on a page, e.g. posting a status update on",
  "the lead site; fill values come from valueTemplate. A target may itself carry",
  '{{vars.*}} (e.g. click_text "{{vars.lead_name}}" opens that lead\'s row on a',
  "portal list); it renders at run time, and a target that renders empty fails",
  "the step. click_text_while_present",
  'repeatedly clicks `target` until it is gone (a varying "Next" wizard).',
  "click_role clicks by ARIA role (target) + accessible name (valueTemplate), for",
  "widgets that aren't plain buttons (e.g. a calendar day cell). select_option",
  "picks an option (valueTemplate) from a native <select> (target = its CSS",
  "selector). click_role/select_option REQUIRE a valueTemplate. A browse_action",
  'may also carry "rememberUrlKeyedByVar":"lead_phone" to persist its final URL',
  "keyed by that phone var, so a LATER run for the same person can recall it. A",
  'browse_action may instead carry "forEachLink":"<css selector>" to loop the',
  "actions over EVERY matching list row (the service visits each row's href and",
  "runs the actions there), e.g. apply a status update to every lead in a list;",
  "forEachLink can't be combined with fields/screenshot/rememberUrlKeyedByVar. Add",
  '"forEachLinkMatchVar":"<var>" alongside forEachLink to only act on rows whose',
  "text contains one of the names in that earlier var (comma/newline/semicolon",
  "separated), e.g. update only the leads named in an inbound text. A",
  "recall_url step looks that URL up into {{vars.<saveAs>}} using the inbound",
  'group participants ("keyFromTrigger":"participants") and/or phone vars',
  '("keyVars":[...]); it saves "" on a miss, so guard the consuming step with a',
  '"when" (e.g. contains "http"). A step\'s optional "when" guard takes exactly one',
  'of {"var":"x","equals":"v"} / {"var":"x","contains":"v"} /',
  '{"var":"x","notEquals":"v"}; pair equals/notEquals on the same var for an',
  'either/or branch (e.g. one notify_owner when phone_lead_type equals "none",',
  'another when it notEquals "none"). {{now.today.*}} / {{now.tomorrow.*}} /',
  "{{now.in7Days.*}} expose relative dates in the business timezone (weekday,",
  "month, monthNum, day, dayOrdinal, year, iso) and {{now.afternoonTime}} is",
  '"14:00". Use these for a "tomorrow afternoon" or "follow up in 7 days" style',
  "follow-up instead of hard-coding a date. A",
  'browse_extract with "screenshot":true also captures a screenshot of the page;',
  'a later send_email or route_to_team with "attachScreenshot":true attaches it',
  "(as an email attachment / agent-offer MMS). attachScreenshot requires an",
  'earlier browse_extract with "screenshot":true. A browse_extract may also',
  'carry "extractLinks":[{"name":"claim_url","matchText":"Claim"}] to save a',
  'matching link\'s href as a var, "skipWhenText":"already claimed" to end the',
  'run gracefully when the page shows that text,',
  '"continueWhenText":"you just accepted" to skip only THAT STEP and keep the',
  "rest of the run going when the page proves the step's goal is already met",
  "(both options work on browse_extract and browse_action; skipWhenText ends the",
  "run, continueWhenText does not), and \"auth\":{\"integrationLabel\":",
  '"<the stored integration\'s label>"} to log in first, only when the user',
  'names a login/integration they have saved. A browse_action may carry',
  '"expectText":"We\'re calling you" as PROOF the actions worked: after every',
  "action completes the page must show that text or the step fails like an",
  "action failure (a button can be clicked and still do nothing on a page that",
  "is mid-load; use it on clicks that matter). An email_extract may carry",
  '"noMatchVars":{"u1_status":"missing"} to write those values (into',
  "still-empty vars only) when NO email matches, so a later step gated on the",
  "status can tell \"looked and found nothing\" from \"never looked\".",
  "Saved-person references (toRef/",
  "fromRef/agentRef/notifyRef) are picked in the editor and can NOT be authored",
  "here. Use the literal phone/name fields instead."
].join("\n");

/** One business document the compiler may bind a share_document step to. */
export type CompileDocumentOption = {
  id: string;
  title: string;
  summary: string;
};

/**
 * Render the AVAILABLE DOCUMENTS block for the compile/repair user text.
 * Only client-eligible, ready documents belong here (the route filters);
 * an explicit "(none on file)" line tells the model to omit share_document
 * steps rather than invent a uuid, the same NEVER-invent contract as
 * email connection ids.
 */
export function buildAvailableDocumentsBlock(documents: CompileDocumentOption[]): string {
  if (documents.length === 0) {
    return "AVAILABLE DOCUMENTS: (none on file, do not emit share_document steps)";
  }
  const lines = documents.map(
    (d) => `- documentId: ${d.id}, "${d.title}"${d.summary ? `: ${d.summary}` : ""}`
  );
  return ["AVAILABLE DOCUMENTS (for share_document steps; copy documentId exactly):", ...lines].join(
    "\n"
  );
}

/** One saved agent the compiler may bind a run_agent step to. */
export type CompileAgentOption = {
  id: string;
  name: string;
  /** First line(s) of the instructions, for matching intent. */
  instructionsSummary: string;
};

/**
 * Render the AVAILABLE AGENTS block for the compile/repair user text. Only
 * enabled agents belong here (the caller filters); an explicit "(none)"
 * line tells the model to omit run_agent steps rather than invent a uuid,
 * the same NEVER-invent contract as documents and connection ids.
 */
export function buildAvailableAgentsBlock(agents: CompileAgentOption[]): string {
  if (agents.length === 0) {
    return "AVAILABLE AGENTS: (none saved, do not emit run_agent steps)";
  }
  const lines = agents.map(
    (a) =>
      `- agentId: ${a.id}, "${a.name}"${a.instructionsSummary ? `: ${a.instructionsSummary}` : ""}`
  );
  return ["AVAILABLE AGENTS (for run_agent steps; copy agentId exactly):", ...lines].join("\n");
}

/** One connected mailbox the compiler may bind email sends/triggers to. */
export type CompileMailboxOption = {
  /** The workspace_oauth_connections ROW id (what the runtime resolves). */
  id: string;
  /** Owner-recognizable label, e.g. "sam@example.com (outlook)". */
  label: string;
};

/**
 * Render the AVAILABLE MAILBOXES block for the compile/repair/edit user
 * text. Only email-provider connections belong here (the caller filters);
 * an explicit "(none connected)" line tells the model to omit
 * `fromConnectionId` / email triggers / email_extract rather than invent a
 * uuid, the same NEVER-invent contract as documents and agents. The AI
 * coworker's own mailbox is always the no-id default sender.
 */
export function buildAvailableMailboxesBlock(mailboxes: CompileMailboxOption[]): string {
  if (mailboxes.length === 0) {
    return (
      "AVAILABLE MAILBOXES: (none connected, do not emit send_email fromConnectionId, " +
      "email-channel triggers, or email_extract steps; the AI coworker's own mailbox is the " +
      "default sender and needs no id)"
    );
  }
  const lines = mailboxes.map((m) => `- connectionId: ${m.id}, ${m.label}`);
  return [
    "AVAILABLE MAILBOXES (for send_email fromConnectionId, email-channel triggers, and email_extract connectionId; copy the uuid exactly):",
    ...lines
  ].join("\n");
}

export function buildFlowCompileUserText(
  description: string,
  documents: CompileDocumentOption[] = [],
  agents: CompileAgentOption[] = [],
  mailboxes: CompileMailboxOption[] = []
): string {
  return [
    buildAvailableDocumentsBlock(documents),
    "",
    buildAvailableAgentsBlock(agents),
    "",
    buildAvailableMailboxesBlock(mailboxes),
    "",
    `Automation description:\n${description.trim()}`
  ].join("\n");
}

/**
 * Self-repair user text: the first candidate failed validation, so re-prompt
 * with the exact issues and the failing JSON. One repair round only: if the
 * model can't fix its own output with the errors in hand, surface the
 * (humanized) failure to the user instead of burning tokens in a loop.
 */
export function buildFlowRepairUserText(input: {
  description: string;
  candidateJson: string;
  issues: string[];
  documents?: CompileDocumentOption[];
  agents?: CompileAgentOption[];
  mailboxes?: CompileMailboxOption[];
}): string {
  return [
    "Your previous automation definition FAILED validation. Fix ONLY the",
    "problems listed below and return the FULL corrected JSON definition",
    "(same schema contract; output only the JSON object).",
    "",
    "Validation problems:",
    ...input.issues.map((i) => `- ${i}`),
    "",
    "Your previous (invalid) definition:",
    input.candidateJson,
    "",
    buildAvailableDocumentsBlock(input.documents ?? []),
    "",
    buildAvailableAgentsBlock(input.agents ?? []),
    "",
    buildAvailableMailboxesBlock(input.mailboxes ?? []),
    "",
    "Original automation description:",
    input.description.trim()
  ].join("\n");
}

/**
 * Translate recurring validation failures into guidance a business owner can
 * act on. Unmatched issues pass through as-is (they are already sentence-ish
 * from validateDefinitionSemantics); zod path prefixes are stripped either way.
 */
export function humanizeCompileIssues(issues: string[]): string[] {
  return issues.map((raw) => {
    const issue = raw.trim();
    if (/trigger\.connectionId/i.test(issue)) {
      return (
        "The email trigger needs one of your connected inboxes, which the AI can't pick for you. " +
        'Tip: if the email arrives at your AI coworker\'s own address (forwarded lead alerts, Privyr, portals), choose the "AI coworker\'s mailbox" trigger instead: it needs no connection.'
      );
    }
    if (/^trigger\./i.test(issue)) {
      return `There's a problem with the trigger: ${issue.replace(/^trigger\./i, "")}. Try describing when the automation should start (a text, an email to the coworker's mailbox, a webhook, or a schedule).`;
    }
    if (/uses \{\{vars\.(\w+)\}\} before any step produces it/i.test(issue)) {
      return `${issue} Tip: add an earlier "read details" step that extracts that value, or reorder the steps.`;
    }
    // steps.<n>.<field>: zod path: point at the step number in plain words.
    const stepPath = /^steps\.(\d+)\.?(.*?): (.*)$/.exec(issue);
    if (stepPath) {
      return `Step ${Number(stepPath[1]) + 1}${stepPath[2] ? ` (${stepPath[2]})` : ""}: ${stepPath[3]}`;
    }
    return issue;
  });
}

/**
 * User text for adapting an existing (library) definition to a new business.
 * The model receives the source definition plus the new owner's concrete
 * details and any free-text tweak, and must return a full adapted definition
 * following the same schema contract as the compile system prompt.
 */
export function buildFlowAdaptUserText(input: {
  sourceDefinition: unknown;
  ownerPhone?: string | null;
  ownerEmail?: string | null;
  employeeNames?: string[];
  instructions?: string;
}): string {
  const lines = [
    "Adapt the following AiFlow definition for a new business. Keep its structure",
    "and intent, but replace placeholder/old contact details with the new",
    "business's details below. Output the full adapted definition as JSON.",
    "",
    "Source definition (may contain placeholders like {{owner_phone}},",
    "{{owner_email}}, {{employee_name}}, replace these):",
    JSON.stringify(input.sourceDefinition),
    "",
    "New business details:"
  ];
  lines.push(`- Owner phone: ${input.ownerPhone?.trim() || "(none on file)"}`);
  lines.push(`- Owner email: ${input.ownerEmail?.trim() || "(none on file)"}`);
  lines.push(
    `- Team members: ${
      input.employeeNames && input.employeeNames.length > 0
        ? input.employeeNames.join(", ")
        : "(none on file)"
    }`
  );
  if (input.instructions?.trim()) {
    lines.push("", `Additional instructions: ${input.instructions.trim()}`);
  }
  return lines.join("\n");
}

/**
 * User text for editing an EXISTING flow in place (the chat `edit_aiflow`
 * tool). Unlike adapt, which rewrites a library template for a new business,
 * an edit must be surgical: the model gets the current definition plus the
 * owner's requested change and must return the full updated definition,
 * copying everything the owner did not ask to change verbatim (ids included)
 * so an applied edit never churns untouched steps.
 */
export function buildFlowEditUserText(input: {
  currentName: string;
  currentDefinitionJson: string;
  instructions: string;
  documents?: CompileDocumentOption[];
  agents?: CompileAgentOption[];
  mailboxes?: CompileMailboxOption[];
}): string {
  return [
    `Edit the business's EXISTING AiFlow automation named "${input.currentName}".`,
    "Apply ONLY the requested changes below and build the FULL updated",
    "definition (same schema contract), which you will return under the",
    '"definition" key described at the end of this message. Copy every',
    'part the request does not mention VERBATIM: same step "id" values, same',
    "wording, same order. Never drop, rewrite, or renumber untouched steps, and",
    "never invent connection/document/agent uuids that are not in the current",
    "definition or the lists below.",
    "",
    "Current definition:",
    input.currentDefinitionJson,
    "",
    buildAvailableDocumentsBlock(input.documents ?? []),
    "",
    buildAvailableAgentsBlock(input.agents ?? []),
    "",
    buildAvailableMailboxesBlock(input.mailboxes ?? []),
    "",
    "Requested changes:",
    input.instructions.trim(),
    "",
    "Output ONLY a JSON object with exactly these two top-level keys, and",
    "nothing else. Do not return the definition on its own:",
    '  "definition": the FULL updated definition object described above.',
    '  "questions": an array of short plain-English questions.',
    "",
    "Put a question in that array for anything the request left genuinely",
    "ambiguous that you had to GUESS about: which teammate, which of two",
    "similarly named steps, how long a wait should be, whether a change",
    "applies to one branch or all of them. Ask about the guess you actually",
    "made, phrased for the business owner, not about schema details. Return an",
    "empty array when the request was specific enough that you guessed at",
    "nothing. Never use a question as a substitute for doing the work: still",
    "return your best definition alongside it."
  ].join("\n");
}

/**
 * Split the edit response envelope `{ definition, questions }` from a bare
 * definition.
 *
 * The edit prompt asks for the envelope, but a model that answers with a
 * bare definition (or the self-repair retry, whose prompt is about fixing
 * validation issues) must still work: that degrades to "no questions", never
 * to a parse failure. Detection is by shape rather than by trusting the key
 * to exist, since a definition itself never has a `definition` key.
 */
export function splitFlowEditEnvelope(candidate: unknown): {
  definition: unknown;
  questions: string[];
} {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { definition: candidate, questions: [] };
  }
  const obj = candidate as Record<string, unknown>;
  const questions = Array.isArray(obj.questions)
    ? obj.questions
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter((q) => q.length > 0)
    : [];

  if ("definition" in obj) return { definition: obj.definition, questions };

  // A BARE definition that carried its questions alongside the steps. Reading
  // them here matters more than it looks: silently dropping them would let
  // Layer 4 fail open, staging a change the model told us it had guessed at.
  // The key is stripped so the definition still validates as itself.
  if ("questions" in obj) {
    const { questions: _dropped, ...definition } = obj;
    return { definition, questions };
  }

  return { definition: candidate, questions: [] };
}

/**
 * Tolerant JSON extraction from a model response: handles a bare object,
 * fenced/prose-wrapped output, and returns null when nothing parseable is found.
 * The caller still validates the result with parseAiFlowDefinition.
 */
export function extractFlowJson(raw: string): unknown {
  const noFence = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(noFence);
  } catch {
    // fall through to brace-slice recovery
  }
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(noFence.slice(start, end + 1));
  } catch {
    return null;
  }
}
