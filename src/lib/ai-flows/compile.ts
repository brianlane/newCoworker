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
  '  {"id":"s3","type":"send_sms","to":"{{vars.seller_phone}}","body":"...{{trigger.from}}"}',
  '  {"id":"s3b","type":"send_email","to":"owner@example.com","cc":["manager@example.com"],"bcc":["archive@example.com"],"subject":"{{vars.lead_name}} lead","body":"...","attachScreenshot":true}',
  '  {"id":"s4","type":"approval_gate","prompt":"..."}',
  '  {"id":"s5","type":"notify_owner","message":"..."}',
  '  {"id":"s6","type":"http_call","label":"crm","method":"POST","path":"/x","bodyTemplate":"...","saveAs":"resp"}',
  '  {"id":"s6a","type":"sleep","minutes":300}                                            // pause then continue (1-43200 min); OR {"untilTime":"08:30","timezone":"America/Toronto"} to wait until a local time of day — exactly one mode',
  '  {"id":"s6b","type":"wait_for_reply","phoneVar":"lead_phone","saveAs":"reply_text","timeoutMinutes":300}   // park until that phone texts back; the reply lands in {{vars.reply_text}} ("no_reply" if they never replied)',
  '  {"id":"s7","type":"route_to_team","offerTemplate":"New lead {{vars.lead_name}}, reply 1 to claim or 2 to pass by {{offer.deadline}}","responseMinutes":10,"ownerFallbackTemplate":"No agent claimed {{vars.lead_name}}","claimedNotifyTemplate":"{{agent.name}} claimed {{vars.lead_name}}","agentName":"<optional: pin offers to this roster member>","offerWindow":{"timezone":"America/Phoenix","quietStart":"21:00","quietEnd":"08:30","graceMinutes":10},"attachScreenshot":true}',
  '  {"id":"s8","type":"browse_action","urlVar":"lead_url","actions":[{"kind":"click_text","target":"Leave an update"},{"kind":"fill_placeholder","target":"Add an update","valueTemplate":"{{vars.actions_taken}}"}],"screenshot":true,"rememberUrlKeyedByVar":"lead_phone"}',
  '  {"id":"s9","type":"recall_url","keyFromTrigger":"participants","saveAs":"lead_url"}   // recall a link a PRIOR run saved for this same person',
  "",
  'For "wait N hours and follow up if they don\'t respond" style requests, use',
  "wait_for_reply (NOT sleep): send_sms the lead, then wait_for_reply on their",
  'phone var with timeoutMinutes = the wait, then a follow-up send_sms guarded by',
  '"when":{"var":"reply_text","equals":"no_reply"} (they never replied) and/or',
  'another step guarded by "when":{"var":"reply_text","notEquals":"no_reply"}',
  "(they did). While a wait_for_reply is parked, the lead's next text is captured",
  "by the flow and the default AI conversational reply stays quiet for that",
  "message. Use sleep only for unconditional pauses (e.g. wait until 08:30",
  "before texting).",
  "",
  "Prefer extract_text over browse_extract when the triggering message ALREADY",
  "contains the lead details (name, phone, email, address in the SMS/email",
  "itself): extract_text parses the same fields straight from the message text",
  "with no link to open. Use browse_extract ONLY when the needed details live",
  "behind a link/login and must be read from a fetched page. Both produce",
  "{{vars.<field>}} the same way.",
  "",
  "Rules: a step may only reference {{vars.X}} produced by an EARLIER step, or",
  "{{trigger.url}}, {{trigger.windowText}}, {{trigger.from}} (empty for schedule",
  "triggers; for email triggers windowText is subject+body, from is the sender,",
  "url is the first link in the message; for calendar triggers windowText is the",
  "event's title/time/location/attendees/description lines, from is the organizer",
  "email, and {{trigger.event_title}} / {{trigger.starts_at}} /",
  "{{trigger.ends_at}} are also available). {{vars.actions_taken}}",
  "is engine-provided (a running summary of sends/routing) and always available.",
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
  '"their" person. A send_sms step',
  'has exactly one recipient: a templated "to", "replyToGroup":true (reply into',
  'the inbound group MMS thread), or "toAgentName":"<name>" (text one named',
  "roster member — the engine resolves their current phone, and only then may",
  "the body use {{agent.name}} / {{agent.phone}}). A send_sms step",
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
  'earlier browse_extract with "screenshot":true.'
].join("\n");

export function buildFlowCompileUserText(description: string): string {
  return `Automation description:\n${description.trim()}`;
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
