/**
 * Client-safe registry of every integration shown on
 * /dashboard/integrations. One entry per integration drives both the hub
 * directory tiles and the per-integration detail pages
 * (/dashboard/integrations/[slug]), so the two can never drift.
 *
 * No secrets or server-only imports belong here: this module is imported
 * from server AND client components.
 */

import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  Bot,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Hash,
  Send,
  Users,
  KeyRound,
  Mail,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Plug,
  Video
} from "lucide-react";

export type IntegrationSlug =
  | "google"
  | "microsoft"
  | "workspace"
  | "slack"
  | "telegram"
  | "teams"
  | "google_chat"
  | "vagaro"
  | "acuity"
  | "calendly"
  | "caldav"
  | "meta"
  | "whatsapp"
  | "zoom"
  | "custom"
  | "zapier-api"
  | "claude"
  | "chatgpt";

export type IntegrationDef = {
  slug: IntegrationSlug;
  name: string;
  category: string;
  /** One-sentence, action-oriented description of what connecting does. */
  benefit: string;
  icon: LucideIcon;
  /** Only owners (manage_billing) may see/manage this integration. */
  ownerOnly?: boolean;
};

/** Ordered category labels for the hub page. */
export const INTEGRATION_CATEGORIES = [
  "Workspace",
  "Team chat",
  "Lead sources",
  "Meetings",
  "Custom",
  "Zapier & API",
  "AI assistants"
] as const;

export const INTEGRATIONS: IntegrationDef[] = [
  {
    slug: "google",
    name: "Google",
    category: "Workspace",
    benefit:
      "Connect Gmail and Google Calendar, including a personal Google account, so your coworker can send email and manage your calendar.",
    icon: Mail
  },
  {
    slug: "microsoft",
    name: "Microsoft 365",
    category: "Workspace",
    benefit:
      "Connect Outlook mail and calendar, on Microsoft 365 or a personal Outlook account, so your coworker can send email and book meetings.",
    icon: Building2
  },
  {
    slug: "slack",
    name: "Slack",
    category: "Team chat",
    benefit:
      "Bring your coworker into Slack: alerts for leads, bookings, and handoffs land in a channel you pick, right where your team already works.",
    // lucide dropped brand icons, so the channel hash stands in for Slack.
    icon: Hash
  },
  {
    slug: "telegram",
    name: "Telegram",
    category: "Team chat",
    benefit:
      "Bring your coworker into Telegram: urgent alerts arrive on your phone with no template approval and no per-message fee, and you can message back to ask anything.",
    // lucide dropped brand icons; Send is the paper plane Telegram uses.
    icon: Send
  },
  {
    slug: "teams",
    name: "Microsoft Teams",
    category: "Team chat",
    benefit:
      "Bring your coworker into Microsoft Teams: alerts land where your team already works, and anyone on your roster can message it back using their Microsoft account.",
    // lucide dropped brand icons; Users stands in for a Teams workspace.
    icon: Users
  },
  {
    slug: "google_chat",
    name: "Google Chat",
    category: "Team chat",
    benefit:
      "Bring your coworker into Google Chat: alerts land in the space your team already uses, and anyone on your roster can message it back using their Google Workspace account.",
    // lucide dropped brand icons; MessagesSquare stands in for a Chat space.
    icon: MessagesSquare
  },
  {
    slug: "vagaro",
    name: "Vagaro",
    category: "Workspace",
    benefit:
      "Let your coworker check real availability and book appointments on your Vagaro calendar, and start AiFlows from Vagaro events.",
    icon: CalendarClock
  },
  {
    slug: "acuity",
    name: "Acuity Scheduling",
    category: "Workspace",
    benefit:
      "Let your coworker check real availability and book appointments on your Acuity calendar, and start AiFlows from Acuity appointments.",
    icon: CalendarCheck
  },
  {
    slug: "calendly",
    name: "Calendly",
    category: "Workspace",
    benefit:
      "Let your coworker offer your Calendly availability and text customers a booking link they confirm on your Calendly page.",
    icon: CalendarRange
  },
  {
    slug: "caldav",
    name: "Apple iCloud / CalDAV",
    category: "Workspace",
    benefit:
      "Connect an iCloud, Nextcloud, or any CalDAV calendar so your coworker can check availability and book straight onto it.",
    icon: CalendarDays
  },
  {
    // Last in the Workspace section on purpose: it is the catch-all for
    // everything the named tiles above do not cover.
    slug: "workspace",
    name: "Other 3rd Party Connections",
    category: "Workspace",
    benefit:
      "Connect OneDrive, 1Password, and the rest of the long tail connections through the Nango Connect flow. Google and Microsoft 365 have their own pages.",
    icon: Plug
  },
  {
    slug: "meta",
    name: "Meta Lead Ads",
    category: "Lead sources",
    benefit:
      "Connect your Facebook Page and every new ad lead starts your webhook AiFlows within seconds, no Zapier or Make account needed.",
    icon: Megaphone
  },
  {
    slug: "whatsapp",
    name: "WhatsApp Business",
    category: "Lead sources",
    benefit:
      "Chat with leads on WhatsApp: your coworker answers automatically, and AiFlows and owner alerts can message contacts there too.",
    icon: MessageCircle
  },
  {
    slug: "zoom",
    name: "Zoom",
    category: "Meetings",
    benefit:
      "Let your coworker schedule Zoom meetings on your account and send customers the join link for video appointments.",
    icon: Video
  },
  {
    slug: "custom",
    name: "Custom integrations",
    category: "Custom",
    benefit:
      "Point your coworker at your own tools and portals (CRM, order system, scheduling tool) with an API key or login.",
    icon: Blocks
  },
  {
    slug: "zapier-api",
    name: "Zapier & API access",
    category: "Zapier & API",
    benefit:
      "Create API keys to connect Zapier's 7,000+ apps or call the public REST API, and see which Zap triggers are live.",
    icon: KeyRound,
    ownerOnly: true
  },
  {
    slug: "claude",
    name: "Claude connector",
    category: "AI assistants",
    benefit:
      "Let Claude work with your coworker: look up contacts, read texts and call summaries, send messages, and book appointments as you.",
    icon: Bot
  },
  {
    slug: "chatgpt",
    name: "ChatGPT app",
    category: "AI assistants",
    benefit:
      "Let ChatGPT work with your coworker: look up contacts, read texts and call summaries, send messages, and book appointments as you.",
    icon: Bot
  }
];

export function getIntegration(slug: string): IntegrationDef | null {
  return INTEGRATIONS.find((i) => i.slug === slug) ?? null;
}

/** Tile/status display state for an integration. */
export type IntegrationStatus = {
  state: "connected" | "attention" | "disconnected";
  label: string;
};
