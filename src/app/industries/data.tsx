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
 * object here.
 */

export type IndustryUseCase = {
  title: string;
  description: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

export type Industry = {
  slug: string;
  name: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Card blurb on the /industries index. */
  teaser: string;
  /** Detail-page hero. */
  headline: string;
  subheadline: string;
  useCases: IndustryUseCase[];
  /** "A day with your coworker" walkthrough steps. */
  dayInTheLife: { time: string; event: string }[];
  complianceNote?: string;
  /**
   * Noun phrase for "your <noun>" CTA copy. Defaults to
   * "<name lowercased> business" — override where that reads badly
   * (e.g. "Small Business" would render "small business business").
   */
  ctaNoun?: string;
};

export const INDUSTRIES: Industry[] = [
  {
    slug: "real-estate",
    name: "Real Estate",
    Icon: Home,
    teaser:
      "Answer every buyer and seller call, qualify leads in seconds, and book showings straight onto your calendar, with Fair Housing guardrails built in.",
    headline: "Never lose a listing lead to voicemail again",
    subheadline:
      "Buyers call the first agent who answers. Your AI coworker picks up every call 24/7, qualifies the lead, books the showing, and texts the follow-up while you're at a closing.",
    useCases: [
      {
        title: "Lead Qualification in Seconds",
        description:
          "Every inquiry is qualified on the first call: buying or selling, timeline, pre-approval, and neighborhood, captured and logged before you even see the notification.",
        Icon: Users
      },
      {
        title: "Showings Booked Mid-Call",
        description:
          "Connected to your calendar, your coworker offers real open slots and books the showing while the caller is still excited.",
        Icon: CalendarCheck
      },
      {
        title: "After-Hours Coverage",
        description:
          "Sunday open-house traffic and 9pm Zillow browsers get a live conversation, not a callback queue.",
        Icon: Phone
      },
      {
        title: "Instant Text Follow-Up",
        description:
          "Missed a warm transfer during a showing? The caller gets an immediate text and the conversation continues over SMS.",
        Icon: MessageSquareText
      },
      {
        title: "Fair Housing Guardrails",
        description:
          "FHA compliance rules are enforced in every conversation, protecting your license from a costly slip.",
        Icon: ShieldCheck
      },
      {
        title: "Transaction Follow-Ups",
        description:
          "AiFlows chase the gap between contract and close: document reminders, milestone updates, and check-ins run themselves.",
        Icon: Workflow
      }
    ],
    dayInTheLife: [
      { time: "7:42 AM", event: "A seller calls about listing their home. Your coworker qualifies the lead, captures the address, and books a listing consult for Thursday." },
      { time: "11:15 AM", event: "You're in a showing. Two buyer calls come in at once. Both answered, both qualified, one showing booked." },
      { time: "2:30 PM", event: "A buyer texts asking about a property's HOA. Your coworker answers from your website knowledge and offers a viewing slot." },
      { time: "9:20 PM", event: "A relocating family calls after dinner. Your coworker walks them through your service, captures their criteria, and texts you a summary with sentiment." }
    ],
    complianceNote:
      "New Coworker's real estate guardrails include Fair Housing Act compliance in every voice and text conversation."
  },
  {
    slug: "home-services",
    name: "Home Services",
    Icon: Wrench,
    teaser:
      "Plumbers, electricians, HVAC: win the job by being the company that actually answers, and let auto-texts rescue every missed warm transfer call.",
    headline: "The company that answers wins the job",
    subheadline:
      "Homeowners call down the list until someone picks up. Your AI coworker answers every call, quotes your availability, books the appointment, and texts confirmations, even while your crew is on a roof.",
    useCases: [
      {
        title: "Every Emergency Call Answered",
        description:
          "Burst pipe at midnight? Your coworker answers, captures the details, and escalates to you by text or warm transfer.",
        Icon: Phone
      },
      {
        title: "Jobs Booked on the Spot",
        description:
          "Real calendar slots offered mid-call, so the homeowner never has time to call your competitor.",
        Icon: CalendarCheck
      },
      {
        title: "Missed-Call Rescue",
        description:
          "On a ladder with both hands full? The caller instantly gets a text and the job is saved, not lost from an unanswered forwarded call.",
        Icon: MessageSquareText
      },
      {
        title: "Appointment Reminders",
        description:
          "Scheduled texts confirm tomorrow's window and cut no-shows without you lifting a finger.",
        Icon: Bell
      },
      {
        title: "Team Dispatch",
        description:
          "Route jobs to the right tech by SMS with acceptance tracking. First to accept gets the job.",
        Icon: Users
      },
      {
        title: "Call Summaries & Sentiment",
        description:
          "Skim every conversation's AI summary on your dashboard at the end of the day. No voicemail box to dig through.",
        Icon: Sparkles
      }
    ],
    dayInTheLife: [
      { time: "6:50 AM", event: "A homeowner calls about a dead water heater. Your coworker books the first available slot and texts the confirmation." },
      { time: "12:05 PM", event: "Three calls land during a crawl-space job. All answered; two booked; one warm-transferred to you as urgent." },
      { time: "4:40 PM", event: "Tomorrow's customers get automatic reminder texts with their arrival windows." },
      { time: "10:30 PM", event: "An after-hours emergency call is answered, triaged, and escalated to your on-call phone with full context." }
    ]
  },
  {
    slug: "medical-dental",
    name: "Medical & Dental",
    Icon: HeartPulse,
    teaser:
      "Fill the schedule and stop losing patients to hold music: appointment booking, reminders, and after-hours answering on private infrastructure.",
    headline: "Every patient call answered. Every chair filled.",
    subheadline:
      "Front desks get slammed; patients hang up. Your AI coworker answers every call, books and confirms appointments, and handles after-hours questions, all on infrastructure dedicated to your practice.",
    useCases: [
      {
        title: "Appointment Scheduling",
        description:
          "New and returning patients book real slots on your calendar during the call. No callback list.",
        Icon: CalendarCheck
      },
      {
        title: "No-Show Reduction",
        description:
          "Scheduled reminder texts confirm every appointment and re-book cancellations automatically.",
        Icon: Bell
      },
      {
        title: "After-Hours Answering",
        description:
          "Evening and weekend callers get answers and next-day bookings instead of an answering-service invoice.",
        Icon: Phone
      },
      {
        title: "Overflow Coverage",
        description:
          "When the front desk is helping a patient, overflow calls roll to your coworker instead of voicemail.",
        Icon: Users
      },
      {
        title: "Private By Design",
        description:
          "A dedicated server per practice, with patient conversations isolated per business and never shared.",
        Icon: ShieldCheck
      },
      {
        title: "Recall Campaigns",
        description:
          "AiFlows text patients who are due for cleanings or follow-ups and book them straight onto the schedule.",
        Icon: Workflow
      }
    ],
    dayInTheLife: [
      { time: "8:01 AM", event: "Monday-morning rush: five calls in ten minutes. All answered; three appointments booked; two questions resolved." },
      { time: "1:20 PM", event: "A patient cancels by text. Your coworker re-books them and offers the freed slot to the waitlist." },
      { time: "5:45 PM", event: "An after-hours caller asks about insurance acceptance. Answered from your website knowledge, with a booking for Thursday." },
      { time: "7:00 PM", event: "Tomorrow's patients receive confirmation texts; responses are handled automatically." }
    ]
  },
  {
    slug: "law-firms",
    name: "Law Firms",
    Icon: Scale,
    teaser:
      "Every potential client intake captured: after-hours answering, conflict-free scheduling, and instant follow-up texts that beat the firm across town.",
    headline: "The first firm to respond gets the client",
    subheadline:
      "Potential clients call several firms and retain the one that responds first. Your AI coworker answers every call, runs intake, books the consultation, and follows up by text, nights and weekends included.",
    useCases: [
      {
        title: "Client Intake, Every Time",
        description:
          "Matter type, urgency, and contact details captured on the first call and summarized to your dashboard.",
        Icon: Users
      },
      {
        title: "Consultations Booked",
        description:
          "Qualified callers book real consultation slots on your calendar before they hang up.",
        Icon: CalendarCheck
      },
      {
        title: "After-Hours Answering",
        description:
          "Arrests, accidents, and disputes don't keep business hours. Your coworker answers when opposing counsel's firm doesn't.",
        Icon: Phone
      },
      {
        title: "Speed-to-Lead Texts",
        description:
          "Every missed or after-hours forwarded caller gets an immediate text, keeping your firm first in mind.",
        Icon: MessageSquareText
      },
      {
        title: "Warm Transfers for Urgent Matters",
        description:
          "Time-sensitive callers are transferred to you live, with the intake context already captured.",
        Icon: Bell
      },
      {
        title: "Private Infrastructure",
        description:
          "A dedicated server per firm, with client conversations isolated per business and never shared.",
        Icon: ShieldCheck
      }
    ],
    dayInTheLife: [
      { time: "8:15 AM", event: "A potential PI client calls before the office opens. Intake runs, urgency is flagged, and a consult is booked for 11 AM." },
      { time: "12:40 PM", event: "During a deposition, two calls are answered and triaged; one urgent matter is texted to you with a summary." },
      { time: "6:30 PM", event: "A family-law inquiry after hours: intake captured, consultation booked, follow-up text sent." },
      { time: "9:55 PM", event: "You skim the day's call summaries and sentiment on the dashboard in five minutes." }
    ]
  },
  {
    slug: "restaurants",
    name: "Restaurants",
    Icon: UtensilsCrossed,
    ctaNoun: "restaurant",
    teaser:
      "Reservations taken, hours and menu questions answered, and catering leads captured, even during the dinner rush when nobody can reach the phone.",
    headline: "Every table filled. Every call answered.",
    subheadline:
      "During service, the phone loses to the kitchen every time. Your AI coworker answers every call, takes reservations, handles hours and menu questions, and captures catering inquiries while your staff stays with guests.",
    useCases: [
      {
        title: "Reservations Without the Rush",
        description:
          "Callers book real slots on your calendar mid-call, so a full dining room never costs you tomorrow's covers.",
        Icon: CalendarCheck
      },
      {
        title: "Hours, Menu & Allergy Questions",
        description:
          "Your coworker answers from your website and business knowledge: hours, parking, gluten-free options, private dining.",
        Icon: Sparkles
      },
      {
        title: "Dinner-Rush Overflow",
        description:
          "When the host stand is slammed, calls roll to your coworker instead of voicemail, and no reservation is lost.",
        Icon: Phone
      },
      {
        title: "Catering & Event Leads",
        description:
          "Large-party and catering inquiries are qualified, captured, and summarized to your dashboard for follow-up.",
        Icon: Users
      },
      {
        title: "Confirmation & Reminder Texts",
        description:
          "Scheduled texts confirm reservations and cut no-shows without anyone working a call-back list.",
        Icon: Bell
      },
      {
        title: "Missed-Call Auto-Text",
        description:
          "Any forwarded call that can't be answered gets an instant text, keeping the guest engaged until you're free.",
        Icon: MessageSquareText
      }
    ],
    dayInTheLife: [
      { time: "10:20 AM", event: "A caller asks about weekend availability for a party of eight. Your coworker books it and texts the confirmation." },
      { time: "12:45 PM", event: "Lunch rush: three calls arrive while every server is on the floor. All answered; two reservations, one to-go question." },
      { time: "6:30 PM", event: "A catering inquiry for a 50-person office event is qualified and captured; you get the summary between seatings." },
      { time: "9:40 PM", event: "Tomorrow's reservations receive confirmation texts; one cancellation is re-booked automatically." }
    ]
  },
  {
    slug: "small-business",
    name: "Small Business",
    Icon: Building2,
    ctaNoun: "small business",
    teaser:
      "Whatever you run, if customers call and text it, your coworker answers it, books it, and follows it up, for less than an answering service.",
    headline: "A full front office for less than an answering service",
    subheadline:
      "Salons, gyms, shops, agencies: every business that loses customers to unanswered phones gets a 24/7 employee that answers, books, texts, and remembers every customer.",
    useCases: [
      {
        title: "24/7 Answering",
        description:
          "Every call answered in your business's voice, with your services, hours, and policies already learned.",
        Icon: Phone
      },
      {
        title: "Bookings & Reservations",
        description:
          "Appointments booked straight onto your calendar while the customer is on the line.",
        Icon: CalendarCheck
      },
      {
        title: "Two-Way Texting",
        description:
          "Customers text your number and get real answers, plus scheduled texts and saved templates for campaigns.",
        Icon: MessageSquareText
      },
      {
        title: "Customer Memory",
        description:
          "Regulars are remembered: preferences, history, and past conversations inform every interaction.",
        Icon: Sparkles
      },
      {
        title: "Analytics & Alerts",
        description:
          "See call trends and peak hours; get alerted when calls are being missed.",
        Icon: Bell
      },
      {
        title: "8,000+ Integrations",
        description:
          "Zapier connects your coworker to the CRM, spreadsheet, or booking tool you already use.",
        Icon: Workflow
      }
    ],
    dayInTheLife: [
      { time: "9:05 AM", event: "A new customer calls asking about pricing. Answered from your website knowledge, then booked for Saturday." },
      { time: "1:30 PM", event: "Lunch rush: three calls handled at once while you serve customers." },
      { time: "5:15 PM", event: "A regular texts to reschedule. Done in one exchange, calendar updated." },
      { time: "11:00 PM", event: "A night-owl browser calls, gets every question answered, and books. You find the summary in the morning." }
    ]
  }
];

export function getIndustry(slug: string): Industry | undefined {
  return INDUSTRIES.find((i) => i.slug === slug);
}
