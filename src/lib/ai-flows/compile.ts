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
  '  "options": { "suppressDefaultReply": <optional bool>, "captureStepScreenshots": <optional bool> }',
  "}",
  "",
  "Trigger channels (pick the one matching how the workflow should start; if the",
  'owner describes SEVERAL ways it can start — "when a lead texts OR emails" —',
  'put the first in "trigger" and the rest in "triggers"):',
  '  {"channel":"sms","correlationWindowMinutes":<optional int 0-1440>,"conditions":[...]}   // inbound text; [] matches every SMS',
  '  {"channel":"manual"}                                                                    // only via the dashboard Run-now button',
  '  {"channel":"schedule","timezone":"America/Phoenix","time":"08:30","daysOfWeek":[1,2,3,4,5]}  // daily clock (daysOfWeek optional, 0=Sun)',
  '  {"channel":"schedule","everyMinutes":60}                                                // interval clock (min 15)',
  '  {"channel":"tenant_email","conditions":[...]}                                           // inbound email to the AI coworker\'s OWN mailbox (forwarded lead alerts, Privyr/portal notifications, anything sent or forwarded to the coworker\'s address); [] matches every email',
  '  {"channel":"email","connectionId":"<uuid of a connected mailbox>","conditions":[...]}   // inbound email to the owner\'s CONNECTED Gmail/Outlook inbox — ONLY when the user explicitly says their own connected inbox AND supplies a real connection uuid; NEVER invent or placeholder the uuid — when in doubt use tenant_email instead (it needs no connectionId)',
  '  {"channel":"webhook","conditions":[...]}                                                // an outside tool posts a lead/event to the coworker\'s webhook (Meta/Facebook lead ads via Zapier or Make, website forms, any API caller); [] matches every event',
  '  {"channel":"calendar","on":"event_created","calendar":"both","conditions":[...]}        // a new event is added to the connected calendar ("primary"), the shared NewCoworker calendar ("shared"), or "both"',
  '  {"channel":"calendar","on":"event_start","leadMinutes":30,"calendar":"both","conditions":[...]}  // N minutes before an event starts (reminders)',
  '  {"channel":"calendar","on":"event_end","followMinutes":60,"calendar":"both","conditions":[...]}   // N minutes AFTER an event\'s ACTUAL end time (post-appointment follow-ups; followMinutes optional, 0/omitted = right at the end). Prefer this over event_start + sleep for anything that happens after the appointment — it tracks the event\'s real length',
  '  {"channel":"calendar","on":"event_canceled","calendar":"both","conditions":[...]}       // a watched calendar event is canceled/deleted (rebooking nudges)',
  '  {"channel":"contact_created","conditions":[...]}                                        // a NEW contact lands on the Contacts page (added by hand, imported, or filed by another flow); conditions match the contact\'s name/phone/email/tags text',
  '  {"channel":"tag_changed","tag":"Appointment Scheduled","change":"added","conditions":[...]}   // a tag is added ("added", default) or removed ("removed") on a contact; omit "tag" to match ANY tag — chain flows off lead-status tags (a flow never retriggers itself via its own tag writes)',
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
  '  {"id":"s2","type":"browse_extract","urlVar":"lead_url","fields":[{"name":"seller_phone","description":"..."}],"screenshot":true}',
  '  {"id":"s2t","type":"extract_text","fields":[{"name":"lead_name","description":"..."},{"name":"lead_phone","description":"..."}]}   // parse fields straight from the inbound message text',
  '  {"id":"s2e","type":"email_extract","connectionId":"<uuid of a connected mailbox>","fromContains":"referral","matchTemplates":["{{vars.lead_name}}"],"lookbackMinutes":60,"fields":[{"name":"lead_phone"}],"fillOnlyEmpty":true}   // backfill fields from a recent email in the owner\'s CONNECTED mailbox — ONLY when the user supplies a real connection uuid; NEVER invent it',
  '  {"id":"s3","type":"send_sms","to":"{{vars.seller_phone}}","body":"...{{trigger.from}}"}',
  '  {"id":"s3b","type":"send_email","to":"owner@example.com","cc":["manager@example.com"],"bcc":["archive@example.com"],"subject":"{{vars.lead_name}} lead","body":"...","attachScreenshot":true}',
  '  {"id":"s4","type":"approval_gate","prompt":"..."}',
  '  {"id":"s5","type":"notify_owner","message":"..."}',
  '  {"id":"s6","type":"http_call","label":"crm","method":"POST","path":"/x","bodyTemplate":"...","saveAs":"resp"}',
  '  {"id":"s6a","type":"sleep","minutes":300}                                            // pause then continue (1-43200 min); OR {"untilTime":"08:30","timezone":"America/Toronto"} (a local time of day); OR {"untilDateTemplate":"{{vars.renewal_date}}"} (an extracted date); OR {"relativeToTemplate":"{{trigger.starts_at}}","offsetMinutes":-120} (N minutes before/after a date — negative = before) — exactly ONE mode',
  '  {"id":"s6m","type":"math","operation":"add","left":"{{vars.lead_score}}","right":"10","saveAs":"lead_score"}   // arithmetic on numbers/dates: add/subtract/multiply/divide/round (round takes only "left"), date_add_minutes (left=ISO date, right=minutes → ISO), date_diff_days (whole days left→right); unparseable operands save "not_a_number" — use the result in later when/branch conditions (lead scoring, "renewal within 30 days")',
  '  {"id":"s6b","type":"wait_for_reply","phoneVar":"lead_phone","saveAs":"reply_text","timeoutMinutes":300}   // park until that phone texts back; the reply lands in {{vars.reply_text}} ("no_reply" if they never replied)',
  '  {"id":"s6d","type":"goal","label":"Appointment booked","events":[{"kind":"appointment_booked"},{"kind":"tag_added","tag":"Appointment Scheduled"}]}   // GOAL checkpoint: the moment any watched milestone happens for this lead (kinds: "replied", "appointment_booked", "tag_added" — needs "tag", "claimed"), the run JUMPS here and every step in between is skipped — use it to stop follow-up nudges once the lead converts (e.g. sms nurture: send_sms → sleep → send_sms → goal). Trunk-only: never inside a branch. Reached normally it just passes through',
  '  {"id":"s6c","type":"branch","question":"Did they reply?","branches":[{"id":"b1","label":"They replied","condition":{"var":"reply_text","notEquals":"no_reply"},"steps":[{"id":"s6c1","type":"send_sms","to":"{{vars.lead_phone}}","body":"Great! Book here: ..."}]}],"else":[{"id":"s6c2","type":"notify_owner","message":"{{vars.lead_name}} never replied — calling them next."}]}   // multi-path if/else: 1-4 branches checked top to bottom (first match wins), each with its OWN nested steps; no match runs the "else" steps; nesting max 3 deep',
  '  {"id":"s7","type":"route_to_team","offerTemplate":"New lead {{vars.lead_name}}, reply 1 to claim or 2 to pass by {{offer.deadline}}","responseMinutes":10,"ownerFallbackTemplate":"No agent claimed {{vars.lead_name}}","claimedNotifyTemplate":"{{agent.name}} claimed {{vars.lead_name}}","agentName":"<optional: pin offers to this roster member>","offerWindow":{"timezone":"America/Phoenix","quietStart":"21:00","quietEnd":"08:30","graceMinutes":10},"attachScreenshot":true}',
  '  {"id":"s8","type":"browse_action","urlVar":"lead_url","actions":[{"kind":"click_text","target":"Leave an update"},{"kind":"fill_placeholder","target":"Add an update","valueTemplate":"{{vars.actions_taken}}"}],"screenshot":true,"rememberUrlKeyedByVar":"lead_phone"}',
  '  {"id":"s9","type":"recall_url","keyFromTrigger":"participants","saveAs":"lead_url"}   // recall a link a PRIOR run saved for this same person',
  '  {"id":"s10","type":"upsert_customer","phoneVar":"lead_phone","nameVar":"lead_name","emailVar":"lead_email"}   // save/update the lead on the Contacts page from extracted vars (phoneVar required; add this whenever the flow captures a new lead\'s details)',
  '  {"id":"s11","type":"update_contact","phoneVar":"lead_phone","removeTags":["New Lead"],"addTags":["Contacted"]}   // move the contact between lead-status tags on the Contacts page (removals apply before additions; at least one of addTags/removeTags)',
  '  {"id":"s12","type":"classify","textVar":"reply_text","question":"The lead was asked why they are shopping","categories":[{"value":"wants_a_call","description":"asks to talk/book/call"},{"value":"not_interested","description":"declines or asks to stop"}],"saveAs":"intent"}   // sort a message into EXACTLY ONE category value (2-8, snake_case); nothing-fits lands as "unclear" — pair with a branch step whose arms match each value (and an unclear/else path)',
  '  {"id":"s13","type":"generate_image","promptTemplate":"A clean flyer for {{vars.listing_address}}...","saveAs":"flyer_url"}   // create an AI-generated image and save a link to it as {{vars.flyer_url}}; ONLY include this step when the user explicitly asks for an image to be created (it is expensive and draws from the shared AI budget). Deliver it with a later send_sms carrying "mediaUrlVar":"flyer_url" (goes out as a picture message) or by templating the URL into a send_email body. To EDIT a photo instead of creating from scratch, add "inputImageTemplate":"{{trigger.image}}" — that is the photo attached to the triggering text (MMS) or coworker-mailbox email — and describe the change in promptTemplate (e.g. "Show this face aged 20 years"); {{trigger.image}} is empty when no photo was attached, in which case the step generates from scratch',
  '  {"id":"s15","type":"run_agent","agentId":"<uuid copied EXACTLY from the AVAILABLE AGENTS list>","input":"{{trigger.windowText}}","saveAs":"agent_output"}   // run one of the owner\'s saved Agents (a reusable AI instruction set) on flow content — the rendered input text is transformed per the agent\'s instructions and the result lands in {{vars.<saveAs>}} for later steps (a send_email body, notify_owner, ...). ONLY emit this step when the user message contains an AVAILABLE AGENTS list with a matching agent — copy its agentId EXACTLY; NEVER invent or placeholder the uuid, and when no listed agent matches, leave the step out entirely',
  '  {"id":"s14","type":"share_document","documentId":"<uuid copied EXACTLY from the AVAILABLE DOCUMENTS list>","to":"{{vars.lead_phone}}","via":"sms","messageTemplate":"Here is our price sheet: {{share_url}}","saveAs":"price_sheet_url"}   // text ("via":"sms", to = a phone) or email ("via":"email", to = an email address) the lead an expiring link to one of the business uploaded documents (price sheet, policy, contract, brochure). Use this — never paste document contents into a send_sms body — whenever the user says to send their price sheet / policy / brochure / packet. The literal token {{share_url}} in messageTemplate marks where the link goes (omit it and the link is appended); optional "saveAs" exposes the link to later steps. ONLY emit this step when the user message contains an AVAILABLE DOCUMENTS list with a matching document — copy its documentId EXACTLY; NEVER invent or placeholder the uuid, and when no listed document matches, leave the step out entirely',
  "",
  "Voice steps (ONLY under a voice trigger; a voice flow uses exactly ONE",
  "trigger and only these steps — never mix them with the steps above):",
  '  {"id":"v1","type":"ring_handoff","toE164":"+15559876543","ringSeconds":20}             // ring a human; on no-answer the next ring_handoff (or the AI takeover) runs — step order is the ring order',
  '  {"id":"v2","type":"voice_ai_intake","notifyE164":"+15559876543","persona":"Amy\'s assistant taking a message","captureFields":["name","phone","reason for calling"]}   // AFTER every ring missed, the AI answers, captures the lead, and texts the summary to notifyE164; at most one, and it must be the LAST step',
  '  {"id":"v3","type":"voice_transfer","toE164":"+15559876543","whisper":"Connecting you now"}   // connect the caller straight to one number; must be the flow\'s ONLY step',
  '  {"id":"v4","type":"outbound_call","toE164":"+15551230000","notifyE164":"+15559876543","persona":"...","captureFields":["confirmed appointment"]}   // outbound voice flows only: the AI places the call and texts the summary; must be the ONLY step',
  "",
  'To ROUTE a conversation on what a reply MEANS ("if they want a call, offer',
  'the team; if they say stop, close out"), chain wait_for_reply → classify on',
  "its saveAs var → branch with one arm per category value plus an else for",
  '"unclear"/no_reply. Never branch on raw reply text with contains — leads',
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
  "url is the first link in the message; for calendar triggers windowText is the",
  "event's title/time/location/attendees/description lines, from is the organizer",
  "email, and {{trigger.event_title}} / {{trigger.starts_at}} /",
  "{{trigger.ends_at}} are also available). {{vars.actions_taken}}",
  "is engine-provided (a running summary of sends/routing) and always available.",
  "{{vars.group_lead_phone}} is engine-provided on group-text triggers: the lead's",
  "number — the one thread participant besides the sender and the business's own",
  "numbers. Only filled when a from_matches condition pins the sender (a known",
  "service), so a lead-sent message never mislabels the service as the lead;",
  "empty when not a group text, the sender is unpinned, or the roster is ambiguous.",
  "{{coworker.email}} is the AI coworker's own mailbox address and is always",
  "available (e.g. for an email signature or to cc the coworker itself).",
  "Prefer an approval_gate before any send_sms to a scraped number. A",
  "route_to_team step offers the lead to team members one at a time (reply",
  "1=claim, 2=pass) with timed escalation and an owner fallback; only its",
  "templates may use {{agent.name}} / {{agent.phone}} (the offered team member)",
  "and {{offer.deadline}} (the resolved claim deadline). An optional offerWindow",
  "extends overnight offer deadlines to quietEnd + graceMinutes. Optional",
  '"preferContactOwner":true offers a repeat lead to the teammate who already',
  "owns that contact (from an earlier claim or manual assignment) before the",
  "normal rotation — use it when the owner says leads should go back to",
  '"their" person. Optional "firstToClaim":false disables the default rule that',
  "lets earlier-offered teammates still grab a live offer with a bare \"1\".",
  'An optional keep-for-owner pair — "ownerDirectWhen":{"var":"price_band",',
  '"equals":"over_1m"} with "ownerDirectTemplate":"Kept for you: ..." — sends',
  "matching leads straight to the owner and never offers the team (use when",
  'the owner says "leads like X come to me"); both fields are required',
  "together. A send_sms step",
  'has exactly one recipient: a templated "to", "replyToGroup":true (reply into',
  'the inbound group MMS thread), or "toAgentName":"<name>" (text one named',
  "roster member — the engine resolves their current phone, and only then may",
  "the body use {{agent.name}} / {{agent.phone}}). A send_sms step",
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
  "the lead site; fill values come from valueTemplate. click_text_while_present",
  'repeatedly clicks `target` until it is gone (a varying "Next" wizard).',
  "click_role clicks by ARIA role (target) + accessible name (valueTemplate), for",
  "widgets that aren't plain buttons (e.g. a calendar day cell). select_option",
  "picks an option (valueTemplate) from a native <select> (target = its CSS",
  "selector). click_role/select_option REQUIRE a valueTemplate. A browse_action",
  'may also carry "rememberUrlKeyedByVar":"lead_phone" to persist its final URL',
  "keyed by that phone var, so a LATER run for the same person can recall it. A",
  'browse_action may instead carry "forEachLink":"<css selector>" to loop the',
  "actions over EVERY matching list row (the service visits each row's href and",
  "runs the actions there) — e.g. apply a status update to every lead in a list;",
  "forEachLink can't be combined with fields/screenshot/rememberUrlKeyedByVar. Add",
  '"forEachLinkMatchVar":"<var>" alongside forEachLink to only act on rows whose',
  "text contains one of the names in that earlier var (comma/newline/semicolon",
  "separated) — e.g. update only the leads named in an inbound text. A",
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
  '"14:00" — use these for a "tomorrow afternoon" or "follow up in 7 days" style',
  "follow-up instead of hard-coding a date. A",
  'browse_extract with "screenshot":true also captures a screenshot of the page;',
  'a later send_email or route_to_team with "attachScreenshot":true attaches it',
  "(as an email attachment / agent-offer MMS). attachScreenshot requires an",
  'earlier browse_extract with "screenshot":true. A browse_extract may also',
  'carry "extractLinks":[{"name":"claim_url","matchText":"Claim"}] to save a',
  'matching link\'s href as a var, "skipWhenText":"already claimed" to end the',
  'run gracefully when the page shows that text, and "auth":{"integrationLabel":',
  '"<the stored integration\'s label>"} to log in first — only when the user',
  "names a login/integration they have saved. Saved-person references (toRef/",
  "fromRef/agentRef/notifyRef) are picked in the editor and can NOT be authored",
  "here — use the literal phone/name fields instead."
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
 * steps rather than invent a uuid — the same NEVER-invent contract as
 * email connection ids.
 */
export function buildAvailableDocumentsBlock(documents: CompileDocumentOption[]): string {
  if (documents.length === 0) {
    return "AVAILABLE DOCUMENTS: (none on file — do not emit share_document steps)";
  }
  const lines = documents.map(
    (d) => `- documentId: ${d.id} — "${d.title}"${d.summary ? `: ${d.summary}` : ""}`
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
 * line tells the model to omit run_agent steps rather than invent a uuid —
 * the same NEVER-invent contract as documents and connection ids.
 */
export function buildAvailableAgentsBlock(agents: CompileAgentOption[]): string {
  if (agents.length === 0) {
    return "AVAILABLE AGENTS: (none saved — do not emit run_agent steps)";
  }
  const lines = agents.map(
    (a) =>
      `- agentId: ${a.id} — "${a.name}"${a.instructionsSummary ? `: ${a.instructionsSummary}` : ""}`
  );
  return ["AVAILABLE AGENTS (for run_agent steps; copy agentId exactly):", ...lines].join("\n");
}

export function buildFlowCompileUserText(
  description: string,
  documents: CompileDocumentOption[] = [],
  agents: CompileAgentOption[] = []
): string {
  return [
    buildAvailableDocumentsBlock(documents),
    "",
    buildAvailableAgentsBlock(agents),
    "",
    `Automation description:\n${description.trim()}`
  ].join("\n");
}

/**
 * Self-repair user text: the first candidate failed validation, so re-prompt
 * with the exact issues and the failing JSON. One repair round only — if the
 * model can't fix its own output with the errors in hand, surface the
 * (humanized) failure to the user instead of burning tokens in a loop.
 */
export function buildFlowRepairUserText(input: {
  description: string;
  candidateJson: string;
  issues: string[];
  documents?: CompileDocumentOption[];
  agents?: CompileAgentOption[];
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
        'Tip: if the email arrives at your AI coworker\'s own address (forwarded lead alerts, Privyr, portals), choose the "AI coworker\'s mailbox" trigger instead — it needs no connection.'
      );
    }
    if (/^trigger\./i.test(issue)) {
      return `There's a problem with the trigger: ${issue.replace(/^trigger\./i, "")}. Try describing when the automation should start (a text, an email to the coworker's mailbox, a webhook, or a schedule).`;
    }
    if (/uses \{\{vars\.(\w+)\}\} before any step produces it/i.test(issue)) {
      return `${issue} Tip: add an earlier "read details" step that extracts that value, or reorder the steps.`;
    }
    // steps.<n>.<field>: zod path — point at the step number in plain words.
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
    "{{owner_email}}, {{employee_name}} — replace these):",
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
