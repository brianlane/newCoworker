import type { Metadata } from "next";
import {
  AlarmClockCheck,
  BarChart3,
  Bell,
  BookOpenCheck,
  Brain,
  CalendarCheck,
  Clock,
  Globe,
  LayoutDashboard,
  Mail,
  MessageSquareText,
  MessagesSquare,
  Phone,
  PhoneForwarded,
  PhoneIncoming,
  Rocket,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Users,
  Workflow,
  Zap
} from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FeatureGrid,
  PageHero,
  SectionHeading,
  type Feature
} from "@/components/marketing/sections";
import { TIER_LIMITS } from "@/lib/plans/limits";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Everything your AI coworker does: 24/7 call answering, appointment booking, SMS & RCS messaging, AI call summaries, analytics, automated workflows, and 8,000+ integrations.",
  alternates: { canonical: "/features" },
  openGraph: {
    title: "Features | New Coworker",
    description:
      "24/7 call answering, appointment booking, SMS & RCS, AI summaries, analytics, workflows, and 8,000+ integrations.",
    url: "/features"
  }
};

type FeatureGroup = {
  eyebrow: string;
  title: string;
  subtitle: string;
  features: Feature[];
};

const groups: FeatureGroup[] = [
  {
    eyebrow: "Voice",
    title: "Every call answered, every time",
    subtitle:
      "Your coworker answers with human-level conversation, books appointments mid-call, and hands off to you when it matters.",
    features: [
      {
        title: "24/7 AI Call Answering",
        description:
          "Nights, weekends, holidays, and your busiest hours — every caller gets a real conversation, not voicemail.",
        Icon: Phone
      },
      {
        title: `Up to ${TIER_LIMITS.standard.maxConcurrentCalls} Concurrent Calls`,
        description: `On Standard, your coworker holds up to ${TIER_LIMITS.standard.maxConcurrentCalls} conversations at once, so a busy morning never produces a busy signal.`,
        Icon: PhoneIncoming
      },
      {
        title: "Warm Call Transfers",
        description:
          "When a caller needs a human, the call is transferred to you or a teammate with context — the caller never repeats themselves.",
        Icon: PhoneForwarded
      },
      {
        title: "Appointment Booking",
        description:
          "Connected to your Google or Microsoft calendar, your coworker finds open slots and books them during the call.",
        Icon: CalendarCheck
      },
      {
        title: "Lead Qualification",
        description:
          "Caller intent is understood within seconds; details are captured, qualified, and logged so follow-up is effortless.",
        Icon: Users
      },
      {
        title: "Bring Your Own Number",
        description:
          "Port your existing business number in (Standard and up) — or use the dedicated number included with every plan.",
        Icon: Smartphone
      }
    ]
  },
  {
    eyebrow: "Messaging",
    title: "Texts that never sit unread",
    subtitle:
      "Two-way SMS and RCS branded messaging, handled by the same coworker that knows every caller.",
    features: [
      {
        title: "Two-Way SMS",
        description:
          "Customers text your business number and get useful, on-brand replies immediately — day or night.",
        Icon: MessageSquareText
      },
      {
        title: "RCS Branded Messaging",
        description:
          "Verified-sender branding with your logo and read receipts, so your messages stand out from anonymous SMS.",
        Icon: MessagesSquare
      },
      {
        title: "Texts During Calls",
        description:
          "Your coworker can text a caller a link, address, or booking confirmation while still on the phone with them.",
        Icon: Zap
      },
      {
        title: "Missed-Call Auto-Text",
        description:
          "If a call can't be answered, the caller instantly gets a text so the lead never goes cold.",
        Icon: PhoneForwarded
      },
      {
        title: "Scheduled Texts & Templates",
        description:
          "Queue texts for the right moment and keep your best messages as reusable saved templates.",
        Icon: AlarmClockCheck
      },
      {
        title: "Email Handling",
        description:
          "A dedicated email address for your coworker — it reads, triages, and answers email in your voice too.",
        Icon: Mail
      }
    ]
  },
  {
    eyebrow: "Intelligence",
    title: "Know what happened without listening to every call",
    subtitle:
      "Summaries, sentiment, analytics, and a permanent memory that compounds with every conversation.",
    features: [
      {
        title: "AI Call Summaries",
        description:
          "Every call lands on your dashboard with a concise AI summary — what the caller wanted and what happened.",
        Icon: Sparkles
      },
      {
        title: "Caller Sentiment",
        description:
          "See at a glance whether callers left happy, neutral, or frustrated, so you know where to step in.",
        Icon: Users
      },
      {
        title: "Analytics Dashboard",
        description:
          "Call trends, peak hours, and answer rate — the numbers that show whether opportunities are being captured.",
        Icon: BarChart3
      },
      {
        title: "Missed-Call Spike Alerts",
        description:
          "Get alerted when callers are being turned away, before a busy day turns into lost revenue.",
        Icon: Bell
      },
      {
        title: "Permanent Memory",
        description:
          "Lossless, hierarchical memory of your business and customers — context builds forever instead of resetting per chat.",
        Icon: Brain
      },
      {
        title: "Website Knowledge",
        description:
          "Point your coworker at your website and it learns your services, pricing, and policies automatically.",
        Icon: Globe
      }
    ]
  },
  {
    eyebrow: "Automation",
    title: "Workflows that run your follow-up for you",
    subtitle:
      "AiFlows connect triggers to actions across calls, texts, and email — plus real browser skills for everything else.",
    features: [
      {
        title: "AiFlows",
        description:
          "Automated workflows that reply to texts and emails, follow up with leads on schedule, and route work to your team.",
        Icon: Workflow
      },
      {
        title: "Outbound Calls",
        description:
          "Your coworker can place scheduled outbound calls — reminders, confirmations, and follow-ups — on your behalf.",
        Icon: Phone
      },
      {
        title: "Browser Skills",
        description:
          "It can operate real websites — updating CRMs, checking portals, and completing forms, even behind logins.",
        Icon: Globe
      },
      {
        title: "Team Routing",
        description:
          "Offers and tasks route to the right teammate by SMS, with acceptance tracking built in.",
        Icon: Users
      },
      {
        title: "Owner Notifications",
        description:
          "Choose exactly which events reach you — by SMS, email, or dashboard — and when.",
        Icon: Bell
      },
      {
        title: "Scheduled Anything",
        description:
          "Flows run on your schedule: daily digests, weekly check-ins, or the moment a trigger fires.",
        Icon: Clock
      }
    ]
  },
  {
    eyebrow: "Platform",
    title: "A private platform, not a shared bot",
    subtitle:
      "Dedicated infrastructure per business, a full management dashboard, and compliance guardrails built in.",
    features: [
      {
        title: "Dedicated Private Server",
        description:
          "Every business runs on its own server. Conversations and business knowledge stay on your infrastructure.",
        Icon: Server
      },
      {
        title: "Your Dashboard",
        description:
          "Calls, messages, emails, memory, analytics, billing, and settings — one place, any device.",
        Icon: LayoutDashboard
      },
      {
        title: "Compliance Guardrails",
        description:
          "Industry guardrails — including Fair Housing rules for real estate — are enforced in every conversation.",
        Icon: ShieldCheck
      },
      {
        title: "Deploy in Minutes",
        description:
          "Fully automated provisioning: server, phone number, email, and a trained coworker minutes after signup.",
        Icon: Rocket
      },
      {
        title: "Training & Memory Editing",
        description:
          "Review and edit what your coworker knows from the dashboard — its knowledge is yours to shape.",
        Icon: BookOpenCheck
      },
      {
        title: "White-Glove Onboarding",
        description:
          "Optional setup and buildout packages where a specialist configures everything live with you.",
        Icon: Users
      }
    ]
  }
];

export default function FeaturesPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow="Features"
        title={
          <>
            One coworker. <span className="text-claw-green">Every job handled.</span>
          </>
        }
        subtitle="Not a chatbot bolted onto a phone system — a single AI employee that answers, texts, emails, books, remembers, and follows up."
      />

      {groups.map((group) => (
        <section key={group.eyebrow} className="mx-auto max-w-6xl px-6 pb-20">
          <SectionHeading eyebrow={group.eyebrow} title={group.title} subtitle={group.subtitle} />
          <FeatureGrid features={group.features} />
        </section>
      ))}

      <CtaBanner
        title="See it all live on your own number"
        subtitle="Pick a plan and your coworker is answering within minutes — 30-day money-back guarantee."
        ctaLabel="Get Started"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
