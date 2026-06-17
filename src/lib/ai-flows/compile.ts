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
  '  "steps": [ ... ],         // 1-25 ordered steps',
  '  "options": { "suppressDefaultReply": <optional bool> }',
  "}",
  "",
  "Trigger channels (pick the one matching how the workflow should start):",
  '  {"channel":"sms","correlationWindowMinutes":<optional int 0-1440>,"conditions":[...]}   // inbound text; [] matches every SMS',
  '  {"channel":"manual"}                                                                    // only via the dashboard Run-now button',
  '  {"channel":"schedule","timezone":"America/Phoenix","time":"08:30","daysOfWeek":[1,2,3,4,5]}  // daily clock (daysOfWeek optional, 0=Sun)',
  '  {"channel":"schedule","everyMinutes":60}                                                // interval clock (min 15)',
  '  {"channel":"email","connectionId":"<uuid of a connected mailbox>","conditions":[...]}   // inbound email to the owner mailbox',
  "",
  "Condition types (sms/email triggers; for email, from_matches tests the sender address):",
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
  '  {"id":"s7","type":"route_to_team","offerTemplate":"New lead {{vars.lead_name}}, reply 1 to claim or 2 to pass by {{offer.deadline}}","responseMinutes":10,"ownerFallbackTemplate":"No agent claimed {{vars.lead_name}}","claimedNotifyTemplate":"{{agent.name}} claimed {{vars.lead_name}}","agentName":"<optional: pin offers to this roster member>","offerWindow":{"timezone":"America/Phoenix","quietStart":"21:00","quietEnd":"08:30","graceMinutes":10},"attachScreenshot":true}',
  '  {"id":"s8","type":"browse_action","urlVar":"lead_url","actions":[{"kind":"click_text","target":"Leave an update"},{"kind":"fill_placeholder","target":"Add an update","valueTemplate":"{{vars.actions_taken}}"}],"screenshot":true}',
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
  "url is the first link in the message). {{vars.actions_taken}}",
  "is engine-provided (a running summary of sends/routing) and always available.",
  "{{coworker.email}} is the AI coworker's own mailbox address and is always",
  "available (e.g. for an email signature or to cc the coworker itself).",
  "Prefer an approval_gate before any send_sms to a scraped number. A",
  "route_to_team step offers the lead to team members one at a time (reply",
  "1=claim, 2=pass) with timed escalation and an owner fallback; only its",
  "templates may use {{agent.name}} / {{agent.phone}} (the offered team member)",
  "and {{offer.deadline}} (the resolved claim deadline). An optional offerWindow",
  "extends overnight offer deadlines to quietEnd + graceMinutes. A send_sms step",
  'may carry "quietHours":{"timezone":"America/Phoenix","noSendAfter":"22:00",',
  '"resumeAt":"08:30","emailFallbackVar":"lead_email","emailSubject":"..."} so a',
  "late-night lead is emailed right away (when an email was extracted) and the",
  "text still goes out at resumeAt the next morning. A send_email step may",
  'carry "fromConnectionId":"<uuid>" to send',
  "from the owner's connected mailbox instead of the platform sender. A",
  'send_email step may also carry optional "cc" and "bcc" arrays of email',
  "addresses (each up to 10) to copy additional recipients. A",
  "browse_action step performs ordered UI actions (click_text / click_selector /",
  "fill_selector / fill_placeholder) on a page, e.g. posting a status update on",
  "the lead site; fill values come from valueTemplate. A browse_extract",
  'with "screenshot":true also captures a screenshot of the page; a later',
  'send_email or route_to_team with "attachScreenshot":true attaches it (as an',
  "email attachment / agent-offer MMS). attachScreenshot requires an earlier",
  'browse_extract with "screenshot":true.'
].join("\n");

export function buildFlowCompileUserText(description: string): string {
  return `Automation description:\n${description.trim()}`;
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
