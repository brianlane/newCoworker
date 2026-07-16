/**
 * Client-safe registry of every integration shown on
 * /dashboard/integrations. One entry per integration drives both the hub
 * directory tiles and the per-integration detail pages
 * (/dashboard/integrations/[slug]), so the two can never drift.
 *
 * No secrets or server-only imports belong here — this module is imported
 * from server AND client components.
 */

import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  Bot,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Inbox,
  KeyRound,
  Megaphone,
  Video
} from "lucide-react";

export type IntegrationSlug =
  | "workspace"
  | "vagaro"
  | "calendly"
  | "caldav"
  | "meta"
  | "zoom"
  | "custom"
  | "zapier-api"
  | "claude";

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
  "Scheduling",
  "Lead sources",
  "Meetings",
  "Custom",
  "Zapier & API",
  "AI assistants"
] as const;

export const INTEGRATIONS: IntegrationDef[] = [
  {
    slug: "workspace",
    name: "Workspace",
    category: "Workspace",
    benefit:
      "Connect Gmail, Google Calendar, Drive, Microsoft 365, Slack, and more so your coworker can send email and manage your calendar.",
    icon: Inbox
  },
  {
    slug: "vagaro",
    name: "Vagaro",
    category: "Scheduling",
    benefit:
      "Let your coworker check real availability and book appointments on your Vagaro calendar, and start AiFlows from Vagaro events.",
    icon: CalendarClock
  },
  {
    slug: "calendly",
    name: "Calendly",
    category: "Scheduling",
    benefit:
      "Let your coworker offer your Calendly availability and text customers a booking link they confirm on your Calendly page.",
    icon: CalendarRange
  },
  {
    slug: "caldav",
    name: "Apple iCloud / CalDAV",
    category: "Scheduling",
    benefit:
      "Connect an iCloud, Nextcloud, or any CalDAV calendar so your coworker can check availability and book straight onto it.",
    icon: CalendarDays
  },
  {
    slug: "meta",
    name: "Meta Lead Ads",
    category: "Lead sources",
    benefit:
      "Connect your Facebook Page and every new ad lead starts your webhook AiFlows within seconds — no Zapier or Make account needed.",
    icon: Megaphone
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
      "Point your coworker at your own tools and portals — CRM, order system, scheduling tool — with an API key or login.",
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
      "Let Claude work with your coworker — look up contacts, read texts and call summaries, send messages, and book appointments as you.",
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
