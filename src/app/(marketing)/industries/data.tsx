import type { ComponentType, SVGProps } from "react";
import {
  Bell,
  Building2,
  CalendarCheck,
  HeartPulse,
  Home,
  MessageSquareText,
  Phone,
  Scale,
  ShieldCheck,
  Sparkles,
  Users,
  UtensilsCrossed,
  Workflow,
  Wrench
} from "lucide-react";

/**
 * Data-driven industry pages: /industries lists every entry; each entry with
 * `slug` renders at /industries/[slug]. Adding an industry = adding one
 * object here PLUS its copy under `marketing.industries.<i18nKey>` in
 * messages/en.json and messages/es.json (name, teaser, headline,
 * subheadline, u1..u6 use cases, day1..day4 events, ctaNoun, and an
 * optional complianceNote).
 */

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

export type IndustryDef = {
  slug: string;
  /** Catalog namespace under marketing.industries. */
  i18nKey: string;
  Icon: IconType;
  /** Icons for the u1..u6 use cases, in order. */
  useCaseIcons: [IconType, IconType, IconType, IconType, IconType, IconType];
  /** Times shown on the "day with your coworker" walkthrough (not localized). */
  dayTimes: string[];
  hasComplianceNote?: boolean;
};

export const INDUSTRIES: IndustryDef[] = [
  {
    slug: "real-estate",
    i18nKey: "realEstate",
    Icon: Home,
    useCaseIcons: [Users, CalendarCheck, Phone, MessageSquareText, ShieldCheck, Workflow],
    dayTimes: ["7:42 AM", "11:15 AM", "2:30 PM", "9:20 PM"],
    hasComplianceNote: true
  },
  {
    slug: "home-services",
    i18nKey: "homeServices",
    Icon: Wrench,
    useCaseIcons: [Phone, CalendarCheck, MessageSquareText, Bell, Users, Sparkles],
    dayTimes: ["6:50 AM", "12:05 PM", "4:40 PM", "10:30 PM"]
  },
  {
    slug: "medical-dental",
    i18nKey: "medicalDental",
    Icon: HeartPulse,
    useCaseIcons: [CalendarCheck, Bell, Phone, Users, ShieldCheck, Workflow],
    dayTimes: ["8:01 AM", "1:20 PM", "5:45 PM", "7:00 PM"]
  },
  {
    slug: "law-firms",
    i18nKey: "lawFirms",
    Icon: Scale,
    useCaseIcons: [Users, CalendarCheck, Phone, MessageSquareText, Bell, ShieldCheck],
    dayTimes: ["8:15 AM", "12:40 PM", "6:30 PM", "9:55 PM"]
  },
  {
    slug: "restaurants",
    i18nKey: "restaurants",
    Icon: UtensilsCrossed,
    useCaseIcons: [CalendarCheck, Sparkles, Phone, Users, Bell, MessageSquareText],
    dayTimes: ["10:20 AM", "12:45 PM", "6:30 PM", "9:40 PM"]
  },
  {
    slug: "small-business",
    i18nKey: "smallBusiness",
    Icon: Building2,
    useCaseIcons: [Phone, CalendarCheck, MessageSquareText, Sparkles, Bell, Workflow],
    dayTimes: ["9:05 AM", "1:30 PM", "5:15 PM", "11:00 PM"]
  }
];

export function getIndustry(slug: string): IndustryDef | undefined {
  return INDUSTRIES.find((i) => i.slug === slug);
}
