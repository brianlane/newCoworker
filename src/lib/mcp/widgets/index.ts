/**
 * The three inline widgets, and how they attach to tools.
 *
 * Registered once each as MCP resources under `ui://`; ChatGPT loads the
 * document in an iframe and passes the tool's result in at runtime. See
 * ./shell.ts for the rules every widget follows.
 *
 * Which tools get one is not arbitrary. A widget earns its place when the
 * result is something you ACT on or SCAN, and reads worse as prose:
 *
 * - open appointment times, because picking one is a click, not a sentence;
 * - a contact, because it is a set of fields you scan rather than read;
 * - a conversation, because left/right bubbles carry who-said-what for free.
 *
 * Everything else stays text. A widget around a list of automations would be
 * decoration, and decoration is a Content Security Policy surface and a
 * reviewer question for nothing.
 */

import { widgetDocument } from "@/lib/mcp/widgets/shell";

export const MCP_WIDGET_URI = {
  slots: "ui://newcoworker/calendar-slots",
  contact: "ui://newcoworker/contact-card",
  thread: "ui://newcoworker/message-thread"
} as const;

/**
 * OpenAI's Apps SDK reads the HTML as a resource with this profile rather
 * than as plain `text/html`.
 */
export const MCP_WIDGET_MIME = "text/html;profile=mcp-app";

/**
 * Nothing is loaded from anywhere. Declared explicitly because the submission
 * asks for a policy, and "none" is the one that needs no justification.
 */
export const MCP_WIDGET_CSP = {
  connectDomains: [] as string[],
  resourceDomains: [] as string[]
} as const;

const SLOTS = widgetDocument({
  title: "Open times",
  body: '<div class="row"><span class="title">Open times</span><span id="tz" class="muted"></span></div><div id="list" class="stack" style="margin-top:10px"></div>',
  script: `
const render = (data) => {
  const list = document.getElementById("list");
  const tz = document.getElementById("tz");
  list.replaceChildren();
  tz.textContent = data?.timezone ?? "";
  const slots = Array.isArray(data?.slots) ? data.slots : [];
  if (!slots.length) { list.append(el("div","empty","No open times in that window.")); return; }
  for (const slot of slots) {
    const row = el("div","slot");
    const when = new Date(slot.startIso);
    // The host locale, not ours: the person reading it is the one booking.
    const label = isNaN(when.getTime())
      ? String(slot.startIso ?? "")
      : when.toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
    row.append(el("span",null,label));
    const pick = el("button",null,"Use this time");
    pick.addEventListener("click", () => {
      pick.disabled = true;
      // Hand it back as a message rather than booking directly: booking is
      // consequential, and the model should confirm who it is for first.
      try { window.openai?.sendFollowUpMessage?.({ prompt: "Book " + label }); } catch {}
    });
    row.append(pick);
    list.append(row);
  }
};`
});

const CONTACT = widgetDocument({
  title: "Contact",
  body: '<div class="row"><span id="name" class="title"></span><span id="phone" class="muted"></span></div><div id="tags" style="margin-top:8px"></div><div id="fields" class="stack" style="margin-top:10px"></div>',
  script: `
const render = (data) => {
  document.getElementById("name").textContent = data?.name || data?.phone || "Unknown contact";
  document.getElementById("phone").textContent = data?.name ? (data?.phone ?? "") : "";
  const tags = document.getElementById("tags");
  tags.replaceChildren();
  for (const tag of Array.isArray(data?.tags) ? data.tags : []) {
    const t = el("span","tag",tag); t.style.marginRight = "6px"; tags.append(t);
  }
  const fields = document.getElementById("fields");
  fields.replaceChildren();
  const add = (label, value) => {
    if (!value) return;
    const row = el("div","row");
    row.append(el("span","muted",label), el("span",null,value));
    fields.append(row);
  };
  add("Email", data?.email);
  add("Last contact", data?.last_interaction_at ? new Date(data.last_interaction_at).toLocaleDateString() : "");
  add("Conversations", data?.total_interactions);
  if (data?.ai_summary) {
    fields.append(el("div","muted","What we remember"), el("div",null,data.ai_summary));
  }
};`
});

const THREAD = widgetDocument({
  title: "Conversation",
  body: '<div class="row"><span class="title">Conversation</span><span id="who" class="muted"></span></div><div id="msgs" class="stack" style="margin-top:10px"></div>',
  script: `
const render = (data) => {
  document.getElementById("who").textContent = data?.phone ?? "";
  const box = document.getElementById("msgs");
  box.replaceChildren();
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  if (!messages.length) { box.append(el("div","empty","No messages yet.")); return; }
  // Oldest last on screen would read backwards; the tool already returns
  // oldest first, so render in order.
  for (const m of messages) {
    const outbound = m?.direction === "outbound";
    box.append(el("div","msg " + (outbound ? "out" : "in"), m?.text ?? ""));
  }
};`
});

export const MCP_WIDGETS = [
  { uri: MCP_WIDGET_URI.slots, name: "calendar-slots", title: "Open times", html: SLOTS },
  { uri: MCP_WIDGET_URI.contact, name: "contact-card", title: "Contact", html: CONTACT },
  { uri: MCP_WIDGET_URI.thread, name: "message-thread", title: "Conversation", html: THREAD }
] as const;

/** Which tool renders in which widget. Tools not listed stay text-only. */
export const MCP_TOOL_WIDGET: Record<string, string> = {
  calendar_find_slots: MCP_WIDGET_URI.slots,
  get_contact: MCP_WIDGET_URI.contact,
  get_sms_thread: MCP_WIDGET_URI.thread
};

/**
 * The `_meta` a tool carries so a client knows to draw its result.
 *
 * Two keys for one thing: `ui/resourceUri` is the standard, and
 * `openai/outputTemplate` is the alias ChatGPT still reads. Sending only the
 * standard one renders nothing in ChatGPT today; sending only the alias bets
 * on it never being retired.
 */
export function widgetMetaForTool(toolName: string): Record<string, unknown> | undefined {
  const uri = MCP_TOOL_WIDGET[toolName];
  if (!uri) return undefined;
  return {
    ui: { resourceUri: uri, prefersBorder: true, csp: MCP_WIDGET_CSP },
    "openai/outputTemplate": uri
  };
}
