/**
 * scar-fairy-lead-definition.ts: the canonical Scar Fairy "Lead follow-up
 * (white-glove build)" flow definition, extracted from
 * patch-scar-fairy-lead-flow.ts so tests can import the pure builder without
 * executing the script's CLI body. Same split as kyp-offer-definition.ts.
 *
 * Any change to Scar Fairy's live flow shape belongs HERE (and is re-applied
 * with patch-scar-fairy-lead-flow.ts). tests/oneshot-scar-fairy-definitions.test.ts
 * pins the invariants that make the flow do what the owner asked for.
 *
 * Shape, and why:
 *
 *   s_extract / s_file / s_notify_new   Selena hears about the lead at once.
 *   s_sleep_book (3 minutes)            The self-book window. Meta's thank-you
 *                                       page carries the Vagaro link, so a
 *                                       motivated lead books before we ever
 *                                       text. sleep parks the run as `queued`.
 *   s_branch_package                    Deterministic routing on the Facebook
 *                                       lead-form name, one arm per bundle.
 *                                       Each arm sends the text AND the email.
 *   nudge cascade                       Generic, package-agnostic follow-ups.
 *   s_goal (LAST, after every send)     Position is load-bearing, see below.
 *
 * WHY THE 3-MINUTE WINDOW ACTUALLY SKIPS THE SENDS. goal_events.ts defines
 * JUMPABLE_STATUSES = ["queued", "awaiting_reply", "awaiting_call"] and its
 * docstring is explicit that `queued` includes sleep and quiet-hour deferrals.
 * So a Vagaro booking observed during s_sleep_book fast-forwards the run to
 * the first matching `goal` step AHEAD of the current position, recording
 * every step in between as skipped (goal_jump). That is the entire mechanism:
 * s_goal only has to sit after the sends. Move it earlier and a lead who books
 * inside the window gets texted and emailed anyway.
 *
 * Second layer, free: because this definition watches `appointment_booked`,
 * src/lib/ai-flows/booking-precheck.ts runs synchronously before the run's
 * FIRST communication step and suppresses everything when the lead already had
 * a future booking. That is the KYP booked-then-enrolled fix (PR #770).
 * Consequence worth knowing: notify_owner is itself a comm step, so a lead who
 * pre-booked also costs Selena the new-lead alert. That lead is in Vagaro
 * anyway; recorded in docs/tenants/scar-fairy.md rather than worked around.
 *
 * BOTH SKIP LAYERS ARE INERT UNTIL VAGARO OAUTH IS CONNECTED. Without a
 * vagaro_connections row nothing can observe a booking, and the flow degrades
 * to "always text and email after 3 minutes".
 */

export const SCAR_FAIRY_FLOW_NAME = "Lead follow-up (white-glove build)";

/**
 * Sentinel standing in for Selena's real Vagaro booking link, which was still
 * outstanding when this flow was written. patch-scar-fairy-lead-flow.ts REFUSES
 * to --apply while the constant still reads this, so the placeholder can never
 * reach a lead's phone. Landing the real link is a one-line diff plus a re-run.
 */
export const SCAR_FAIRY_BOOKING_LINK_PENDING = "<VAGARO_BOOKING_LINK_PENDING>";

/** Selena's Vagaro booking link. All three bundles share the one link. */
export const SCAR_FAIRY_BOOKING_LINK: string = SCAR_FAIRY_BOOKING_LINK_PENDING;

/** True while the booking link is still the placeholder. */
export function bookingLinkIsPending(link: string = SCAR_FAIRY_BOOKING_LINK): boolean {
  return link === SCAR_FAIRY_BOOKING_LINK_PENDING;
}

/**
 * Lead-facing SMS gate. businesses.timezone is America/New_York (Coral Gables).
 * Hours are a starting position and still need Selena's confirmation; they are
 * deliberately per-step rather than a flow-level timeWindow, so a lead arriving
 * at 2 AM still produces an immediate notify_owner while the text itself waits
 * for 09:00.
 */
export const SCAR_FAIRY_QUIET_HOURS = {
  timezone: "America/New_York",
  noSendAfter: "20:00",
  resumeAt: "09:00"
} as const;

/** How long a lead gets to book on their own before we reach out. */
export const SCAR_FAIRY_SELF_BOOK_MINUTES = 3;

export type ScarFairyPackage = {
  /** Step-id prefix for this arm. */
  prefix: string;
  /** Substring matched against the Facebook lead-form name. */
  formNameContains: string;
  /** Owner-facing arm label. */
  label: string;
  /** Customer-facing package name. */
  packageName: string;
  /** Price, formatted as it should appear to the lead. */
  price: string;
  /** One clause naming the concern, used mid-sentence. */
  concern: string;
};

/**
 * One arm per bundle, matched top to bottom, first match wins. The three
 * substrings do not overlap, so ordering is not load-bearing today; it would
 * become so if a fourth bundle shared a word with one of these.
 */
export const SCAR_FAIRY_PACKAGES: readonly ScarFairyPackage[] = [
  {
    prefix: "melasma",
    formNameContains: "melasma",
    label: "Melasma Bundle",
    packageName: "Melasma Bundle Treatment",
    price: "$499",
    concern: "melasma and hyperpigmentation"
  },
  {
    prefix: "vajacial",
    formNameContains: "vaginal",
    label: "Vaginal Rejuvenation Bundle",
    packageName: "Vaginal Rejuvenation Bundle Treatment",
    price: "$299",
    concern: "vaginal rejuvenation"
  },
  {
    prefix: "acne",
    formNameContains: "acne",
    label: "Back to School Acne Bundle",
    packageName: "Back to School Acne Bundle Treatment",
    price: "$399",
    concern: "acne and post-acne marks"
  }
] as const;

type FlowStepJson = Record<string, unknown>;

/**
 * The text and the email for one bundle. Selena asked for both, so the email is
 * its own step rather than send_sms.quietHours.emailFallbackVar, which would
 * send the email INSTEAD of the text during quiet hours.
 *
 * Copy stays inside what the business can promise: it names the bundle and the
 * price, offers the free analysis, and claims no clinical outcome. Scar Fairy's
 * soul.md already forbids inventing policy, and results claims on melasma or
 * acne are exactly the kind of promise the business has not authorized.
 */
function packageSteps(pkg: ScarFairyPackage, bookingLink: string): FlowStepJson[] {
  const smsBody =
    `Hi {{vars.lead_name}}, this is Scar Fairy in Coral Gables. Thanks for reaching out about ${pkg.concern}. ` +
    `Our ${pkg.packageName} is ${pkg.price}, and every plan starts with a free skin analysis so we can confirm ` +
    `it is the right fit for you. You can grab a time here: ${bookingLink}`;

  const emailBody =
    `Hi {{vars.lead_name}},\n\n` +
    `Thanks for reaching out to Scar Fairy about ${pkg.concern}.\n\n` +
    `Our ${pkg.packageName} is ${pkg.price}. Every plan starts with a free in-person skin analysis, ` +
    `where we look at your skin, talk through your history, and confirm the bundle is the right fit ` +
    `before anything is booked.\n\n` +
    `Scar Fairy is a private skin correction studio in Coral Gables. We work with all skin tones, with ` +
    `particular focus on deeper and melanin-rich complexions, using the Aerolase Neo Elite and customized ` +
    `protocols.\n\n` +
    `Book your free analysis here: ${bookingLink}\n\n` +
    `If you have questions first, just reply to this email or text us back and a human will answer.\n\n` +
    `Selena Breed\nScar Fairy`;

  return [
    {
      id: `${pkg.prefix}_sms`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: smsBody,
      quietHours: { ...SCAR_FAIRY_QUIET_HOURS }
    },
    {
      id: `${pkg.prefix}_email`,
      type: "send_email",
      to: "{{vars.lead_email}}",
      subject: `Your ${pkg.packageName} at Scar Fairy`,
      body: emailBody,
      // Meta lead forms do not guarantee an email. s_extract writes the literal
      // "none" when it is missing, and send_email would fail on an empty `to`.
      when: { var: "lead_email", notEquals: "none" }
    }
  ];
}

/**
 * The fall-through arm: the lead form did not name a bundle, so the first touch
 * names all three rather than guessing. Guessing here quotes a wrong price.
 */
function generalSteps(bookingLink: string): FlowStepJson[] {
  const pricing = SCAR_FAIRY_PACKAGES.map((p) => `${p.packageName} ${p.price}`).join(", ");

  const smsBody =
    "Hi {{vars.lead_name}}, this is Scar Fairy in Coral Gables. Thanks for reaching out. " +
    `Our current bundles are: ${pricing}. Every plan starts with a free skin analysis so we can ` +
    `confirm the right fit for you. Grab a time here: ${bookingLink}` +
    " If you tell me what you are working on, I can point you to the right one.";

  const emailBody =
    `Hi {{vars.lead_name}},\n\n` +
    `Thanks for reaching out to Scar Fairy.\n\n` +
    `Our current bundles are:\n` +
    SCAR_FAIRY_PACKAGES.map((p) => `  - ${p.packageName}: ${p.price}`).join("\n") +
    `\n\nEvery plan starts with a free in-person skin analysis, where we look at your skin, talk through ` +
    `your history, and confirm which bundle fits before anything is booked.\n\n` +
    `Scar Fairy is a private skin correction studio in Coral Gables. We work with all skin tones, with ` +
    `particular focus on deeper and melanin-rich complexions.\n\n` +
    `Book your free analysis here: ${bookingLink}\n\n` +
    `Not sure which one you need? Just reply and tell us what you are working on.\n\n` +
    `Selena Breed\nScar Fairy`;

  return [
    {
      id: "general_sms",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: smsBody,
      quietHours: { ...SCAR_FAIRY_QUIET_HOURS }
    },
    {
      id: "general_email",
      type: "send_email",
      to: "{{vars.lead_email}}",
      subject: "Your free skin analysis at Scar Fairy",
      body: emailBody,
      when: { var: "lead_email", notEquals: "none" }
    }
  ];
}

/**
 * Nudge copy. Package-agnostic on purpose: all three bundles share one Vagaro
 * link, so there is nothing offer-specific left to say once the first touch has
 * named the price. This is the one place the shape diverges from KYP, where the
 * whole cascade lives inside each arm because each offer had its own link.
 */
function nudgeBody(attempt: number, bookingLink: string): string {
  if (attempt === 1) {
    return (
      "Hi {{vars.lead_name}}, just floating this back up. Happy to answer any questions before you book. " +
      `Your free skin analysis is here whenever you are ready: ${bookingLink}`
    );
  }
  if (attempt === 2) {
    return (
      "Hi {{vars.lead_name}}, I do not want you to slip through the cracks. " +
      `The free analysis only takes a few minutes to book: ${bookingLink}`
    );
  }
  return (
    "Hi {{vars.lead_name}}, still here whenever you are ready. " +
    `You can grab a time that works for you here: ${bookingLink}`
  );
}

/** Trunk follow-up cascade: three gated nudges, then hand back to Selena. */
function nudgeSteps(bookingLink: string): FlowStepJson[] {
  const steps: FlowStepJson[] = [];

  for (let i = 1; i <= 3; i++) {
    const replyVar = `reply_${i}`;
    steps.push({
      id: `s_wait_${i}`,
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: replyVar,
      timeoutMinutes: i === 1 ? 120 : 1440,
      ...(i > 1 ? { when: { var: `reply_${i - 1}`, equals: "no_reply" } } : {})
    });
    steps.push({
      id: `s_nudge_${i}`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: nudgeBody(i, bookingLink),
      quietHours: { ...SCAR_FAIRY_QUIET_HOURS },
      when: { var: replyVar, equals: "no_reply" }
    });
  }

  steps.push(
    {
      id: "s_wait_final",
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: "reply_final",
      timeoutMinutes: 1440,
      when: { var: "reply_3", equals: "no_reply" }
    },
    {
      id: "s_flag_owner",
      type: "notify_owner",
      message:
        "Personal touch needed: {{vars.lead_name}} ({{vars.lead_phone}}) has not replied to 3 follow-ups. " +
        "I have marked them Inactive. They are never deleted, and if they reply later the conversation " +
        "picks right back up.",
      when: { var: "reply_final", equals: "no_reply" }
    },
    {
      id: "s_mark_inactive",
      type: "update_contact",
      phoneVar: "lead_phone",
      addTags: ["Inactive"],
      when: { var: "reply_final", equals: "no_reply" }
    }
  );

  return steps;
}

/** Scar Fairy's routed lead-follow-up definition. */
export function buildScarFairyLeadDefinition(
  bookingLink: string = SCAR_FAIRY_BOOKING_LINK
): Record<string, unknown> {
  return {
    version: 1,
    trigger: {
      channel: "webhook",
      // Scoped to Meta leads. The row this replaces carried `conditions: []`,
      // which fired the whole nurture on ANY authenticated webhook event.
      conditions: [{ type: "from_matches", value: "facebook_lead_ads" }]
    },
    steps: [
      {
        id: "s_extract",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "The lead's full name" },
          { name: "lead_phone", description: "The lead's phone number, digits and + only" },
          {
            name: "lead_email",
            description: "The lead's email address; the literal 'none' if the form did not collect one."
          },
          {
            name: "lead_notes",
            description:
              "Everything else the lead provided: custom question answers, skin concern, city, timeframe. 'none' if nothing."
          },
          {
            name: "lead_form_name",
            description:
              "The Facebook lead form name (form_name field from the webhook payload); 'unknown' if missing."
          }
        ]
      },
      {
        id: "s_file",
        type: "upsert_customer",
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        emailVar: "lead_email"
      },
      {
        id: "s_notify_new",
        type: "notify_owner",
        message:
          "New Scar Fairy lead: {{vars.lead_name}}, {{vars.lead_phone}} / {{vars.lead_email}}. " +
          "Form: {{vars.lead_form_name}}. Details: {{vars.lead_notes}}. " +
          `I am giving them ${SCAR_FAIRY_SELF_BOOK_MINUTES} minutes to book on their own, then I follow up by text and email.`
      },
      {
        // The self-book window. See the header note: this is what a booking
        // goal event jumps out of.
        id: "s_sleep_book",
        type: "sleep",
        minutes: SCAR_FAIRY_SELF_BOOK_MINUTES
      },
      {
        id: "s_branch_package",
        type: "branch",
        question: "Route by bundle",
        branches: SCAR_FAIRY_PACKAGES.map((pkg) => ({
          id: `arm_${pkg.prefix}`,
          label: pkg.label,
          condition: {
            var: "lead_form_name",
            contains: pkg.formNameContains,
            caseInsensitive: true
          },
          steps: packageSteps(pkg, bookingLink)
        })),
        else: generalSteps(bookingLink)
      },
      ...nudgeSteps(bookingLink),
      {
        // MUST stay last. See the header note on goal_jump.
        id: "s_goal",
        type: "goal",
        label: "Lead replied or booked",
        events: [{ kind: "appointment_booked" }, { kind: "replied" }]
      }
    ]
  };
}
