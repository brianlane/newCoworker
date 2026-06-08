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
  '  "trigger": {',
  '    "channel": "sms",',
  '    "correlationWindowMinutes": <optional int 0-1440>,',
  '    "conditions": [ ... ]   // AND-ed; [] matches every inbound SMS',
  "  },",
  '  "steps": [ ... ],         // 1-25 ordered steps',
  '  "options": { "suppressDefaultReply": <optional bool> }',
  "}",
  "",
  "Condition types:",
  '  {"type":"contains","value":"text","caseInsensitive":true}',
  '  {"type":"regex","value":"pattern"}',
  '  {"type":"has_url"}',
  '  {"type":"from_matches","value":"+1555..."}',
  "",
  "Step types (each needs a unique \"id\"):",
  '  {"id":"s1","type":"extract_url","saveAs":"lead_url"}',
  '  {"id":"s2","type":"browse_extract","urlVar":"lead_url","fields":[{"name":"seller_phone","description":"..."}]}',
  '  {"id":"s3","type":"send_sms","to":"{{vars.seller_phone}}","body":"...{{trigger.from}}"}',
  '  {"id":"s4","type":"approval_gate","prompt":"..."}',
  '  {"id":"s5","type":"notify_owner","message":"..."}',
  '  {"id":"s6","type":"http_call","label":"crm","method":"POST","path":"/x","bodyTemplate":"...","saveAs":"resp"}',
  "",
  "Rules: a step may only reference {{vars.X}} produced by an EARLIER step, or",
  "{{trigger.url}}, {{trigger.windowText}}, {{trigger.from}}. Prefer an",
  "approval_gate before any send_sms to a scraped number."
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
