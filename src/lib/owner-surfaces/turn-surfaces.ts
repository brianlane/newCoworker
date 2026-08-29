/**
 * Engine configuration for the surfaces that run an owner-operator turn.
 *
 * The identity registry (registry.ts) says what a surface IS. This says how
 * to RUN one: which persona, which prompt block, whose tool settings, how
 * long a reply may be, and how long the turn may take. Two files because
 * registry.ts is imported by action-tools and the flow-history modules and
 * must stay dependency-free, while this one pulls in the personas.
 *
 * Adding a surface is one entry here, one entry in registry.ts, and a
 * caller. The tests refuse an entry that is missing its registry twin or
 * that admits teammates without a persona for them.
 */

import type { AgentKey } from "@/lib/agent-tools/registry";
import { SLACK_SURFACE_BLOCK, SLACK_TEAM_PREAMBLE } from "@/lib/slack/chat";
import {
  TELEGRAM_REPLY_MAX_CHARS,
  TELEGRAM_SURFACE_BLOCK,
  TELEGRAM_TEAM_PREAMBLE
} from "@/lib/telegram/chat";
import {
  TEAMS_REPLY_MAX_CHARS,
  TEAMS_SURFACE_BLOCK,
  TEAMS_TEAM_PREAMBLE
} from "@/lib/teams/chat";
import { NO_EM_DASH_PROMPT_LINE } from "../../../supabase/functions/_shared/sms_prompt_lines";
import type { OwnerSurfaceKey } from "./registry";
import type { SpeakerKind, SurfaceSpeaker } from "./speaker";

/** Surfaces that actually run a turn through the shared owner engine. */
export type OwnerTurnSurfaceKey = Extract<
  OwnerSurfaceKey,
  "sms" | "slack" | "whatsapp" | "telegram" | "teams"
>;

export type OwnerTurnSurface = {
  key: OwnerTurnSurfaceKey;
  /**
   * The registry's `ai_flows.edit_source` for this surface, repeated here
   * so a caller needs one import. The registry test asserts the two agree,
   * so this cannot drift.
   */
  flowEditSource: string;
  /**
   * Whose `agent_tool_settings` row supplies this surface's tool gates.
   * `dashboard` for the surfaces that ARE the owner's own assistant reached
   * from somewhere else, which is what owner-over-SMS has always done.
   */
  toolGateAgentKey: AgentKey;
  /** Speaker kinds this surface will run a staff turn for. */
  serves: readonly SpeakerKind[];
  /** The "THIS CONVERSATION IS OVER X" contract. */
  surfaceBlock: string;
  /** Persona for a teammate speaker; null when the surface is owner-only. */
  teamPreamble: string | null;
  /** One line naming who is speaking, so the model never asks them to prove it. */
  speakerLine: (speaker: SurfaceSpeaker, ref: string) => string;
  /** Heading above the replayed transcript. */
  transcriptLabel: string;
  /** Hard clip on the outgoing reply, as a last resort. */
  replyMaxChars: number;
  /** Wall-clock budget for the model half of the turn. */
  budgetMs: number;
  maxToolSteps: number;
  /** Spend attribution, when the surface has its own bucket. */
  spendSurface?: string;
};

/** SMS replies must fit texting: hard clip as the last resort. */
export const SMS_REPLY_MAX_CHARS = 1200;

/**
 * WhatsApp accepts 4096 characters, but this is a phone chat thread, not
 * email. Sized so a reply stays readable without scrolling forever.
 */
export const WHATSAPP_REPLY_MAX_CHARS = 1600;

// Exported (and re-exported from the owner-SMS route) for the live-AI e2e
// suite: the replay must run against the EXACT production string, not a
// paraphrase, the same convention as sms_prompt_lines.ts.
export const SMS_SURFACE_BLOCK = `THIS CONVERSATION IS OVER SMS. You are texting with the OWNER on their own phone (identity verified by the platform from their number, do not ask them to prove who they are). Everything in OWNER MODE applies here exactly as on the dashboard.
- Keep replies SHORT and plain-text: no markdown, no bullets unless truly needed, well under ${SMS_REPLY_MAX_CHARS} characters.
- You HAVE working tools on this surface (texting, calendar, running automations, editing automations). Use them per your rules; never claim you can't act just because this is SMS.
- When you need a decision (e.g. presenting options), ask ONE clear question and wait for their reply.`;

export const WHATSAPP_SURFACE_BLOCK = `THIS CONVERSATION IS OVER WHATSAPP, on the business's own WhatsApp number. You are messaging with someone from the business, NOT a customer: WhatsApp itself confirms the sender's number and the platform matched it, so never ask them to prove who they are, never run the lead-intake script here, and never ask them for their contact details.
- Keep replies SHORT and plain-text: no markdown, no bullet lists unless you are listing options, well under ${WHATSAPP_REPLY_MAX_CHARS} characters.
- You HAVE working tools on this surface. Use them per your rules; never claim you cannot act just because this is WhatsApp.
- When you need a decision, ask ONE clear question and wait for their reply.`;

export const WHATSAPP_TEAM_PREAMBLE = `You are the business's AI coworker, messaging on WhatsApp with a TEAM MEMBER (their number is on the business's roster; do not ask them to prove who they are, and do not treat them as a customer).
Help them the way a sharp colleague would: answer questions about the business, look things up, check the calendar, draft copy, and take the actions your tools allow.
You are NOT talking to the business owner: account settings, notification preferences, roster changes, spam flags, and sending email are owner-only actions on this surface. If asked, say plainly that the owner can do it from the dashboard or by messaging you themselves.
Ground everything in what your tools return; when you do not know, say so instead of guessing.
${NO_EM_DASH_PROMPT_LINE}`;

const TRANSCRIPT_SUFFIX = "(oldest first, ground truth for what was already said):";

export const OWNER_TURN_SURFACES: Readonly<Record<OwnerTurnSurfaceKey, OwnerTurnSurface>> = {
  sms: {
    key: "sms",
    flowEditSource: "ai_edit_sms",
    toolGateAgentKey: "dashboard",
    // Owner only, and deliberately so: a teammate texting the business line
    // is classified in telnyx-sms-inbound and answered by the Rowboat staff
    // path, which never reaches this engine.
    serves: ["owner"],
    surfaceBlock: SMS_SURFACE_BLOCK,
    teamPreamble: null,
    speakerLine: (speaker, ref) =>
      `The texter is the business OWNER${speaker.name ? `, ${speaker.name}` : ""}, texting from ${ref}.`,
    transcriptLabel: `Recent SMS exchange with the owner ${TRANSCRIPT_SUFFIX}`,
    replyMaxChars: SMS_REPLY_MAX_CHARS,
    // MUST stay below the SMS worker's OWNER_SMS_TURN_TIMEOUT_MS (75s)
    // abort, with room for the EMAIL_SEND fulfilment that runs after the
    // turn returns. See the owner-SMS route for the full reasoning.
    budgetMs: 60_000,
    maxToolSteps: 6
  },
  slack: {
    key: "slack",
    flowEditSource: "ai_edit_slack",
    toolGateAgentKey: "slack",
    serves: ["owner", "teammate"],
    surfaceBlock: SLACK_SURFACE_BLOCK,
    teamPreamble: SLACK_TEAM_PREAMBLE,
    speakerLine: (speaker, ref) =>
      speaker.kind === "owner"
        ? `The speaker is the business OWNER${speaker.name ? `, ${speaker.name}` : ""}, verified from their Slack profile email.`
        : `The speaker is team member ${ref} in the business's Slack workspace.`,
    transcriptLabel: `Recent Slack exchange ${TRANSCRIPT_SUFFIX}`,
    replyMaxChars: 3900,
    budgetMs: 60_000,
    maxToolSteps: 6,
    spendSurface: "slack_chat"
  },
  whatsapp: {
    key: "whatsapp",
    flowEditSource: "ai_edit_whatsapp",
    // The owner's own assistant, reached from WhatsApp: same posture as
    // owner-over-SMS, so it reads the same dashboard toggles rather than
    // needing a settings card nobody has filled in.
    toolGateAgentKey: "dashboard",
    serves: ["owner", "teammate"],
    surfaceBlock: WHATSAPP_SURFACE_BLOCK,
    teamPreamble: WHATSAPP_TEAM_PREAMBLE,
    speakerLine: (speaker, ref) =>
      speaker.kind === "owner"
        ? `The person messaging is the business OWNER${speaker.name ? `, ${speaker.name}` : ""}, from their own WhatsApp number ${ref}.`
        : `The person messaging is ${speaker.name ?? "a team member"}, on the business's roster, from ${ref}.`,
    transcriptLabel: `Recent WhatsApp exchange ${TRANSCRIPT_SUFFIX}`,
    replyMaxChars: WHATSAPP_REPLY_MAX_CHARS,
    budgetMs: 60_000,
    maxToolSteps: 6
  },
  telegram: {
    key: "telegram",
    flowEditSource: "ai_edit_telegram",
    // The owner's own assistant, reached from Telegram: same posture as
    // owner-over-SMS and owner-over-WhatsApp, so it reads the dashboard
    // toggles rather than needing a settings card nobody has filled in.
    // This is also why Telegram adds no AgentKey and no Rowboat seed.
    toolGateAgentKey: "dashboard",
    serves: ["owner", "teammate"],
    surfaceBlock: TELEGRAM_SURFACE_BLOCK,
    teamPreamble: TELEGRAM_TEAM_PREAMBLE,
    speakerLine: (speaker, ref) =>
      speaker.kind === "owner"
        ? `The person messaging is the business OWNER${speaker.name ? `, ${speaker.name}` : ""}, on their connected Telegram account (${ref}).`
        : `The person messaging is ${speaker.name ?? "a team member"}, on the business's roster, from their connected Telegram account (${ref}).`,
    transcriptLabel: `Recent Telegram exchange ${TRANSCRIPT_SUFFIX}`,
    replyMaxChars: TELEGRAM_REPLY_MAX_CHARS,
    budgetMs: 60_000,
    maxToolSteps: 6
  },
  teams: {
    key: "teams",
    flowEditSource: "ai_edit_teams",
    // Same posture as owner-over-SMS, WhatsApp and Telegram: the owner's own
    // assistant reached from somewhere else, so it reads the dashboard
    // toggles rather than needing a settings card nobody has filled in.
    // That is also why Teams adds no AgentKey and no Rowboat seed.
    toolGateAgentKey: "dashboard",
    serves: ["owner", "teammate"],
    surfaceBlock: TEAMS_SURFACE_BLOCK,
    teamPreamble: TEAMS_TEAM_PREAMBLE,
    speakerLine: (speaker, ref) =>
      speaker.kind === "owner"
        ? `The speaker is the business OWNER${speaker.name ? `, ${speaker.name}` : ""}, verified from their Microsoft account (${ref}).`
        : `The speaker is ${speaker.name ?? "a team member"}, on the business's roster, from their Microsoft account (${ref}).`,
    transcriptLabel: `Recent Microsoft Teams exchange ${TRANSCRIPT_SUFFIX}`,
    replyMaxChars: TEAMS_REPLY_MAX_CHARS,
    budgetMs: 60_000,
    maxToolSteps: 6
  }
};

/**
 * The turn configuration for one surface. Throws rather than returning null:
 * every caller is a surface that knows what it is, so a miss is a wiring
 * bug, not a runtime condition to degrade around.
 */
export function ownerTurnSurface(key: OwnerTurnSurfaceKey): OwnerTurnSurface {
  const surface = OWNER_TURN_SURFACES[key];
  if (!surface) throw new Error(`ownerTurnSurface: ${key} does not run owner turns`);
  return surface;
}
