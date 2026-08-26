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
  KIN_COUNSELLING_AGES,
  KIN_GENERAL_BOOKING_LINK,
  allKinBookingLinks,
  resolveKinBooking,
  resolveKinCounsellingAge,
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

/** Every step including those nested in branch arms and else blocks. */
function flatten(list: StepJson[] = steps()): StepJson[] {
  const out: StepJson[] = [];
  const walk = (l: StepJson[]) => {
    for (const st of l) {
      out.push(st);
      const b = st as unknown as { branches?: Array<{ steps: StepJson[] }>; else?: StepJson[] };
      for (const arm of b.branches ?? []) walk(arm.steps);
      if (b.else) walk(b.else);
    }
  };
  walk(list);
  return out;
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
    expect(flatten().find((s) => s.id === "s_nudge_1")?.body).toContain(LINK);
  });

  it("names the clinic in every first text a lead can receive", () => {
    // Recurses: the counselling arm now holds a NESTED age branch, so its
    // greetings are one level deeper than the other disciplines'.
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
    const greetings = flat.filter((st) => String(st.id ?? "").startsWith("s_greet"));
    // 2 terminal disciplines + 3 counselling ages + unknown-age + general.
    expect(greetings.length).toBe(KIN_BOOKING_SERVICES.length - 1 + KIN_COUNSELLING_AGES.length + 2);
    for (const t of greetings) expect(t.body).toContain("KIN Integrated Child Health");
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
    const waits = flatten().filter((s) => s.type === "wait_for_reply");
    expect(waits.map((w) => w.timeoutMinutes)).toEqual([
      KIN_FIRST_FOLLOW_UP_MINUTES,
      KIN_SECOND_FOLLOW_UP_MINUTES,
      KIN_SECOND_FOLLOW_UP_MINUTES
    ]);
    expect(KIN_FIRST_FOLLOW_UP_MINUTES).toBe(120);
    expect(KIN_SECOND_FOLLOW_UP_MINUTES).toBe(1440);
  });

  it("tells an already-booked lead they can ignore the last nudge (JaneApp bookings are invisible to us)", () => {
    const nudge2 = flatten().find((s) => s.id === "s_nudge_2");
    expect(nudge2?.body).toContain("If you already booked");
  });

  it("keeps s_goal last on the MAIN path, watching replied and appointment_booked", () => {
    // Goals may not sit inside a branch, so it stays after the follow-up gate.
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
  it("carries every page Kingsley sent, general last", () => {
    expect(allKinBookingLinks()).toEqual([
      "https://kinintegrated.janeapp.com/#/occupational-therapy",
      "https://kinintegrated.janeapp.com/#/psychological-assessment",
      "https://kinintegrated.janeapp.com/#/child-counselling-ages-3-12",
      "https://kinintegrated.janeapp.com/#/teen-youth-counselling-ages-13-17",
      "https://kinintegrated.janeapp.com/#/adult-counselling",
      // Couples has no flow arm (the form cannot produce it) but must stay in
      // the catalog so the coworker-knowledge drift guard covers it.
      "https://kinintegrated.janeapp.com/#/couples-counselling",
      "https://kinintegrated.janeapp.com/"
    ]);
  });

  it("uses the 13-17 teen slug, never the retired 14-17 one", () => {
    // Kingsley extended the service down to 13 on 2026-08-26 and the slug
    // changed with it. The old link is stale and must not be handed out.
    const all = JSON.stringify([allKinBookingLinks(), buildKinBookingLinksSection()]);
    expect(all).toContain("teen-youth-counselling-ages-13-17");
    expect(all).not.toContain("ages-14-17");
  });

  // The v3 form made the age field collide with the service field: its value
  // `teen_13_to_17` contains "teen", so a flat match sent an occupational
  // therapy lead to counselling. 5 of 12 combinations mis-routed.
  it.each([
    ["counselling", "child_12_and_under", "#/child-counselling-ages-3-12"],
    ["counselling", "teen_13_to_17", "#/teen-youth-counselling-ages-13-17"],
    ["counselling", "adult", "#/adult-counselling"],
    ["occupational_therapy", "child_12_and_under", "#/occupational-therapy"],
    ["occupational_therapy", "teen_13_to_17", "#/occupational-therapy"],
    ["occupational_therapy", "adult", "#/occupational-therapy"],
    ["psychological_assessment", "teen_13_to_17", "#/psychological-assessment"],
    ["psychological_assessment", "child_12_and_under", "#/psychological-assessment"],
    ["speech_slp", "teen_13_to_17", "WAITLIST"],
    ["speech_slp", "child_12_and_under", "WAITLIST"]
  ])("v3 %s + %s books %s", (service, age, expected) => {
    const notes = `what_kind_of_support: ${service}, who_is_the_support_for: ${age}`;
    const got = resolveKinBooking(notes);
    if (expected === "WAITLIST") {
      expect(got.kind).toBe("waitlist");
      return;
    }
    expect(got.kind).toBe("link");
    const url = (got as { url: string }).url;
    if (expected === "GENERAL") expect(url).toBe(KIN_GENERAL_BOOKING_LINK);
    else expect(url).toContain(expected);
  });

  // The ads switch over gradually, so v1 answers must keep working.
  it("still routes the old form's wording while the ads switch", () => {
    const a = resolveKinBooking(
      "what_kind_of_support: Counselling or therapy, who_is_the_support_for: My child (12 and under)"
    );
    expect((a as { url: string }).url).toContain("#/child-counselling-ages-3-12");
    const b = resolveKinBooking(
      "What kind of support: Not sure yet, need guidance. Who is the support for: Our family."
    );
    expect((b as { url: string }).url).toBe(KIN_GENERAL_BOOKING_LINK);
  });

  // Kingsley 2026-08-26: speech runs as a waitlist, so ANY booking link is
  // wrong, including the general page.
  it("opens the waitlist sentence with a capital letter", () => {
    const flat = JSON.stringify(buildKinLeadDefinition(LINK));
    expect(flat).toContain("Speech and language therapy is running on a waitlist");
  });

  // Bugbot, PR #1630: the greeting arm sent no link, but the SHARED nudge
  // cascade still ran and delivered the general booking link two hours later,
  // undoing the waitlist rule entirely.
  it("keeps waitlist leads out of the booking nudge cascade", () => {
    const gate = steps().find((s) => s.id === "s_followups") as never as {
      branches: Array<{ id: string; condition: { contains: string }; steps: StepJson[] }>;
      else: StepJson[];
    };
    const waitlistArm = gate.branches.find((a) => a.id === "arm_no_nudges_waitlist")!;
    // The waitlist arm must do nothing at all.
    expect(waitlistArm.steps).toEqual([]);
    // And it must key off the same token the greeting arm uses.
    expect(waitlistArm.condition.contains).toBe(
      KIN_BOOKING_SERVICES.find((s) => s.waitlist)!.flowMatch
    );
    // Every nudge lives behind the gate, not on the main path.
    const nudgeIds = flatten(gate.else).map((s) => s.id);
    expect(nudgeIds).toContain("s_nudge_1");
    expect(nudgeIds).toContain("s_nudge_2");
    expect(steps().map((s) => s.id)).not.toContain("s_nudge_1");
  });

  it("no longer claims in the owner alert that a link was sent", () => {
    // It fires before the routing branch, so it cannot know, and a speech
    // lead receives no link at all.
    const notify = steps().find((s) => s.id === "s_notify_new");
    expect(notify?.message).not.toContain("sending them the consult booking link");
    expect(notify?.message).toContain("Details: {{vars.lead_notes}}");
  });

  it("never hands a speech lead a booking link", () => {
    for (const notes of [
      "what_kind_of_support: speech_slp, who_is_the_support_for: adult",
      "Speech / SLP",
      "speech therapy for my son"
    ]) {
      const got = resolveKinBooking(notes);
      expect(got.kind).toBe("waitlist");
      expect(JSON.stringify(got)).not.toContain("janeapp.com/#/");
    }
  });

  it("keeps the waitlist service out of the handed-out link catalog", () => {
    expect(allKinBookingLinks()).not.toContain(
      KIN_BOOKING_SERVICES.find((s) => s.waitlist)!.link + "#speech"
    );
    expect(KIN_BOOKING_SERVICES.filter((s) => s.waitlist).map((s) => s.key)).toEqual(["speech"]);
  });

  it("never lets an age word decide a non-counselling discipline", () => {
    for (const age of KIN_COUNSELLING_AGES) {
      const notes = `what_kind_of_support: occupational_therapy, who_is_the_support_for: ${age.flowMatch}`;
      expect((resolveKinBooking(notes) as { url: string }).url).toContain("#/occupational-therapy");
    }
  });

  // Counselling pages turn away the wrong age group, so a missing age must
  // never be guessed into one.
  it("falls back to the general page when counselling has no age answer", () => {
    expect(
      (resolveKinBooking("what_kind_of_support: counselling") as { url: string }).url
    ).toBe(KIN_GENERAL_BOOKING_LINK);
    expect(resolveKinCounsellingAge("counselling please")).toBeNull();
  });

  it("routes an OT assessment to OT, not psychology", () => {
    expect(
      (resolveKinBooking("occupational therapy assessment") as { url: string }).url
    ).toContain("#/occupational-therapy");
    expect(resolveKinService("assessment")).toBeNull();
  });

  it("matches the live arm conditions exactly, service and nested age", () => {
    const branch = steps().find((s) => s.id === "s_route_booking") as never as {
      branches: Array<{ id: string; condition: { contains: string }; steps: StepJson[] }>;
    };
    expect(branch.branches.map((a) => a.condition.contains)).toEqual(
      KIN_BOOKING_SERVICES.map((s) => s.flowMatch)
    );
    const counselling = branch.branches.find((a) => a.id === "arm_counselling")!;
    const nested = counselling.steps[0] as unknown as {
      id: string;
      branches: Array<{ condition: { contains: string } }>;
    };
    expect(nested.id).toBe("s_route_age");
    expect(nested.branches.map((a) => a.condition.contains)).toEqual(
      KIN_COUNSELLING_AGES.map((a) => a.flowMatch)
    );
  });

  it("asks for the age instead of guessing a counselling page", () => {
    const flat = JSON.stringify(buildKinLeadDefinition(LINK));
    expect(flat).toContain("is this for a child, a teenager, or an adult?");
  });



  it("every specific link keeps its JaneApp fragment", () => {
    // The shortener matches https?://[^\s<>"']+ so "#" survives, and the
    // redirect carries it. Lose the fragment and all three specific links
    // silently collapse to the general page.
    // Counselling's own entry points at the general page on purpose: its
    // real pages are age-split and live in KIN_COUNSELLING_AGES.
    for (const s of KIN_BOOKING_SERVICES) {
      if (s.link === KIN_GENERAL_BOOKING_LINK) continue;
      expect(s.link).toContain("#/");
    }
    for (const a of KIN_COUNSELLING_AGES) expect(a.link).toContain("#/");
  });

  it("returns null for missing notes", () => {
    expect(resolveKinService(null)).toBeNull();
    expect(resolveKinService(undefined)).toBeNull();
  });


});

describe("kin coworker knowledge", () => {
  it("tells the coworker speech is a waitlist and to send no link at all", () => {
    const section = buildKinBookingLinksSection();
    expect(section).toContain("WAITLIST, not open booking");
    expect(section).toContain("Send NO link, not even the");
    expect(section).toContain("Do not promise a date");
  });

  it("tells the coworker to ask the age before sending a counselling link", () => {
    const section = buildKinBookingLinksSection();
    expect(section).toContain("COUNSELLING IS SPLIT BY AGE");
    expect(section).toContain("ASK before sending a counselling link");
  });

  it("teaches the coworker every link, so a reply does not dead-end", () => {
    const section = buildKinBookingLinksSection();
    for (const link of allKinBookingLinks()) expect(section).toContain(link);
    expect(section).toContain(KIN_GENERAL_BOOKING_LINK);
  });

  it("spells out the age-split counselling rule in the coworker's own words", () => {
    // Kingsley extended teen to 13, so the old "under 14" framing is wrong:
    // the split is now 3-12 / 13-17 / adult, with no gap.
    const section = buildKinBookingLinksSection();
    expect(section).toContain("Ages 3 to 12");
    expect(section).toContain("13 to 17");
    expect(section).toContain("ASK before sending a counselling link");
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
