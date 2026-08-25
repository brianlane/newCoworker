/**
 * Regression pins for KIN Integrated Child Health's canonical lead flow
 * (scripts/oneshot/kin-lead-definition.ts), the builder that
 * patch-kin-lead-flow.ts re-applies to the live tenant.
 *
 * What these guard, all live defects of the as-installed template before the
 * patch: the greeting carried the intake's typos verbatim and never named
 * the business, no step carried a booking link, and no send step had quiet
 * hours, so a 2 AM Meta lead got a 2 AM text.
 *
 * The placeholder pin matters most: the JaneApp link starts as a sentinel,
 * and the applier refuses to write while it is one. If the sentinel ever
 * stops matching bookingLinkIsPending, that refusal silently dies and a
 * literal "<JANEAPP_BOOKING_LINK_PENDING>" could reach a parent's phone.
 */
import { describe, expect, it } from "vitest";

import {
  buildKinLeadDefinition,
  bookingLinkIsPending,
  KIN_FIRST_FOLLOW_UP_MINUTES,
  KIN_FLOW_NAME,
  KIN_JANEAPP_BOOKING_LINK,
  KIN_JANEAPP_LINK_PENDING,
  KIN_QUIET_HOURS,
  KIN_SECOND_FOLLOW_UP_MINUTES
} from "../scripts/oneshot/kin-lead-definition";
import {
  KIN_BOOKING_SERVICES,
  KIN_GENERAL_BOOKING_LINK,
  allKinBookingLinks,
  resolveKinService
} from "../scripts/oneshot/kin-booking-links";
import {
  buildKinBookingLinksSection,
  buildKinFirstMessageBlock,
  buildKinIdentityMd,
  buildKinSoulMd
} from "../scripts/oneshot/kin-knowledge-content";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

type StepJson = {
  id?: string;
  type?: string;
  body?: string;
  message?: string;
  timeoutMinutes?: number;
  quietHours?: { timezone?: string; noSendAfter?: string; resumeAt?: string };
  events?: Array<{ kind?: string }>;
};

const LINK = "https://example.janeapp.example/consult";

function steps(def = buildKinLeadDefinition(LINK)): StepJson[] {
  return def.steps as StepJson[];
}

describe("kin lead definition", () => {
  it("passes the engine's schema validation", () => {
    expect(() => parseAiFlowDefinition(buildKinLeadDefinition(LINK))).not.toThrow();
  });

  it("keeps the flow name the white-glove apply created, so the patch targets the same row", () => {
    expect(KIN_FLOW_NAME).toBe("Lead follow-up (white-glove build)");
  });

  it("ships the general link in the fallback greeting AND the first nudge", () => {
    const branch = steps().find((s) => s.id === "s_route_booking") as never as {
      else: StepJson[];
    };
    expect(branch.else[0].body).toContain(LINK);
    expect(steps().find((s) => s.id === "s_nudge_1")?.body).toContain(LINK);
  });

  it("names the clinic in every first text a lead can receive", () => {
    const branch = steps().find((s) => s.id === "s_route_booking") as never as {
      branches: Array<{ steps: StepJson[] }>;
      else: StepJson[];
    };
    const firstTexts = [...branch.branches.map((a) => a.steps[0]), branch.else[0]];
    expect(firstTexts).toHaveLength(KIN_BOOKING_SERVICES.length + 1);
    for (const t of firstTexts) expect(t.body).toContain("KIN Integrated Child Health");
  });

  it("carries none of the intake's typos", () => {
    const text = JSON.stringify(buildKinLeadDefinition(LINK));
    expect(text).not.toContain("on you healing");
    expect(text).not.toContain("wanna");
    // The intake greeting's lowercase-L "l'll".
    expect(text).not.toContain("l’ll");
    expect(text).not.toContain("l'll");
  });

  it("holds every lead-facing text to the Edmonton quiet-hours window, arms included", () => {
    const flat: StepJson[] = [];
    const walk = (list: StepJson[]) => {
      for (const st of list) {
        flat.push(st);
        const b = st as unknown as { branches?: Array<{ steps: StepJson[] }>; else?: StepJson[] };
        for (const arm of b.branches ?? []) walk(arm.steps);
        if (b.else) walk(b.else);
      }
    };
    walk(steps());
    const sends = flat.filter((x) => x.type === "send_sms");
    expect(sends.length).toBeGreaterThanOrEqual(KIN_BOOKING_SERVICES.length + 3);
    for (const st of sends) {
      expect(st.quietHours, `step ${st.id} has no quietHours`).toEqual({ ...KIN_QUIET_HOURS });
    }
    expect(KIN_QUIET_HOURS.timezone).toBe("America/Edmonton");
  });

  it("alerts the owner BEFORE the quiet-hours-gated greeting", () => {
    // Quiet hours defer the run at the first gated step. If s_greet ever
    // moves above s_notify_new again, an overnight lead parks the owner
    // alert until 09:00 with it (the Bugbot High on PR #1596).
    const ids = steps().map((s) => s.id);
    expect(ids.indexOf("s_notify_new")).toBeLessThan(ids.indexOf("s_route_booking"));
  });

  it("keeps owner alerts instant (no quiet hours on notify_owner)", () => {
    for (const s of steps().filter((x) => x.type === "notify_owner")) {
      expect(s.quietHours).toBeUndefined();
    }
  });

  it("keeps the cadence Kingsley chose at intake: 2 hours, then next day", () => {
    const waits = steps().filter((s) => s.type === "wait_for_reply");
    expect(waits.map((w) => w.timeoutMinutes)).toEqual([
      KIN_FIRST_FOLLOW_UP_MINUTES,
      KIN_SECOND_FOLLOW_UP_MINUTES,
      KIN_SECOND_FOLLOW_UP_MINUTES
    ]);
    expect(KIN_FIRST_FOLLOW_UP_MINUTES).toBe(120);
    expect(KIN_SECOND_FOLLOW_UP_MINUTES).toBe(1440);
  });

  it("tells an already-booked lead they can ignore the last nudge (JaneApp bookings are invisible to us)", () => {
    const nudge2 = steps().find((s) => s.id === "s_nudge_2");
    expect(nudge2?.body).toContain("If you already booked");
  });

  it("keeps s_goal last, watching replied and appointment_booked", () => {
    const all = steps();
    const last = all[all.length - 1];
    expect(last.id).toBe("s_goal");
    expect(last.events?.map((e) => e.kind).sort()).toEqual(["appointment_booked", "replied"]);
  });

  it("contains no em dashes anywhere in the definition", () => {
    expect(JSON.stringify(buildKinLeadDefinition(LINK))).not.toContain("—");
  });

  it("starts with the placeholder, and the pending check recognizes it", () => {
    // The applier's refusal rests on this exact pair. If someone lands the
    // real link, bookingLinkIsPending() flips false and the applier unlocks.
    expect(bookingLinkIsPending(KIN_JANEAPP_LINK_PENDING)).toBe(true);
    expect(bookingLinkIsPending(LINK)).toBe(false);
    // Deliberately NOT asserting KIN_JANEAPP_BOOKING_LINK is still pending:
    // landing the real link must not fail this suite. Assert only that the
    // default build uses whatever the constant currently is.
    expect(JSON.stringify(buildKinLeadDefinition())).toContain(KIN_JANEAPP_BOOKING_LINK);
  });
});

describe("kin booking-link routing", () => {
  it("carries exactly the four links Kingsley sent, general last", () => {
    expect(allKinBookingLinks()).toEqual([
      "https://kinintegrated.janeapp.com/#/teen-youth-counselling-ages-14-17",
      "https://kinintegrated.janeapp.com/#/occupational-therapy",
      "https://kinintegrated.janeapp.com/#/psychological-assessment",
      "https://kinintegrated.janeapp.com/"
    ]);
  });

  it("every specific link keeps its JaneApp fragment", () => {
    // The shortener matches https?://[^\s<>"']+ so "#" survives, and the
    // redirect carries it. Lose the fragment and all three specific links
    // silently collapse to the general page.
    for (const s of KIN_BOOKING_SERVICES) expect(s.link).toContain("#/");
  });

  it.each([
    ["occupational therapy for my son", "ot"],
    ["Occupational-Therapy", "ot"],
    ["occupational therapy assessment", "ot"],
    ["psychological assessment", "psych"],
    ["we would like to see a psychologist", "psych"],
    ["teen counselling", "teen"],
    ["counselling for my teenager", "teen"]
  ])("routes %j to the %s page", (text, key) => {
    expect(resolveKinService(text)?.key).toBe(key);
  });

  // Bugbot, PR #1619: bare "assessment" used to belong to psych and was
  // checked before OT, so an OT eval landed on the psychological assessment
  // page. OT is now ahead of psych AND the ambiguous word is nobody's token.
  it("never lets the word assessment alone decide a discipline", () => {
    expect(resolveKinService("assessment")).toBeNull();
    expect(resolveKinService("we need an assessment booked")).toBeNull();
    expect(resolveKinService("occupational therapy assessment")?.key).toBe("ot");
  });

  // Bugbot, PR #1619: the branch matched only matches[0] while this function
  // matched every alias, so the two halves disagreed about "youth",
  // "adolescent" and friends. There is now ONE token, and this pins that the
  // live arm condition IS that token.
  it("matches the flow arm conditions exactly, token for token", () => {
    const branch = steps().find((s) => s.id === "s_route_booking") as never as {
      branches: Array<{ id: string; condition: { var: string; contains: string } }>;
    };
    expect(branch.branches.map((a) => a.condition.contains)).toEqual(
      KIN_BOOKING_SERVICES.map((s) => s.flowMatch)
    );
    for (const arm of branch.branches) expect(arm.condition.var).toBe("lead_notes");
    // Every token routes to its own service through the shared resolver.
    for (const svc of KIN_BOOKING_SERVICES) {
      expect(resolveKinService(svc.flowMatch)?.key).toBe(svc.key);
    }
  });

  it("keeps aliases out of the resolver, since the flow cannot match them", () => {
    // They are coworker guidance only; claiming them here would promise a
    // routing the branch cannot perform.
    for (const svc of KIN_BOOKING_SERVICES) {
      for (const alias of svc.aliases) {
        if (alias.includes(svc.flowMatch)) continue;
        expect(resolveKinService(alias)?.key ?? null).not.toBe(svc.key);
      }
    }
  });

  // The age trap: the teen page is scoped 14-17 in JaneApp, and this is a
  // paediatric clinic, so most counselling asks are about younger children.
  // Bare "counselling" must NOT reach the teen page.
  it.each([
    "counselling for my 7 year old",
    "counselling",
    "youth counselling",
    "speech therapy",
    "SLP for my daughter",
    "behaviour consulting",
    "not sure yet",
    ""
  ])("sends %j to the general page rather than guessing", (text) => {
    expect(resolveKinService(text)).toBeNull();
  });

  it("returns null for missing notes", () => {
    expect(resolveKinService(null)).toBeNull();
    expect(resolveKinService(undefined)).toBeNull();
  });

  it("puts teen first so an age signal wins, and OT ahead of psych", () => {
    expect(KIN_BOOKING_SERVICES.map((s) => s.key)).toEqual(["teen", "ot", "psych"]);
    // Both signals present: the age one must win.
    expect(resolveKinService("psychologist for my teen")?.key).toBe("teen");
  });
});

describe("kin coworker knowledge", () => {
  it("teaches the coworker every link, so a reply does not dead-end", () => {
    const section = buildKinBookingLinksSection();
    for (const link of allKinBookingLinks()) expect(section).toContain(link);
    expect(section).toContain(KIN_GENERAL_BOOKING_LINK);
  });

  it("spells out the under-14 counselling rule in the coworker's own words", () => {
    const section = buildKinBookingLinksSection();
    expect(section).toContain("UNDER 14");
    expect(section).toContain("ask how old the child is");
  });

  it("warns the coworker that a bare assessment request is ambiguous", () => {
    expect(buildKinBookingLinksSection()).toContain("assessment ON ITS OWN");
  });

  it("adds Booking Links to identity.md once, and is idempotent", () => {
    const base = "# identity.md\nBusiness Name: KIN\n\n## Offerings\n- OT\n\n## Customer Types\n- Parents\n";
    const once = buildKinIdentityMd(base);
    expect(once).toContain("## Booking Links");
    expect(once.indexOf("## Customer Types")).toBeGreaterThan(once.indexOf("## Booking Links"));
    expect(buildKinIdentityMd(once)).toBe(once);
    expect((once.match(/## Booking Links/g) ?? []).length).toBe(1);
  });

  it("appends Booking Links when identity.md has no Offerings section", () => {
    const out = buildKinIdentityMd("# identity.md\nBusiness Name: KIN\n");
    expect(out).toContain("## Booking Links");
  });

  it("replaces the typo'd white-glove greeting block, and is idempotent", () => {
    const soul = [
      "# soul.md",
      "<!-- white-glove-build:start -->",
      "## White-glove build (from the signed build document)",
      "",
      "### First message & qualification",
      "- greeting: on you healing journey soon. So, l'll help you",
      "",
      "### Hand off to a human immediately (never improvise) on:",
      "- Any time the lead asks for a person."
    ].join("\n");
    const out = buildKinSoulMd(soul);
    expect(out).not.toContain("on you healing");
    expect(out).not.toContain("l'll");
    // The later block survives untouched.
    expect(out).toContain("Any time the lead asks for a person.");
    expect(buildKinSoulMd(out)).toBe(out);
  });

  it("tells the coworker to send the matching link once it knows the discipline", () => {
    expect(buildKinFirstMessageBlock()).toContain("send the matching booking link");
  });

  it("leaves soul.md alone when the block is absent", () => {
    expect(buildKinSoulMd("# soul.md\nno block here")).toBe("# soul.md\nno block here");
  });
});
