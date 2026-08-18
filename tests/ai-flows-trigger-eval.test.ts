import { describe, expect, it } from "vitest";
import {
  EMAIL_WINDOW_TEXT_MAX,
  calendarEventText,
  calendarTriggerScope,
  emailTriggerScope,
  evaluateTriggerConditions,
  firstUrlInText,
  flattenWebhookPayload,
  htmlToText,
  looksLikeStrippedTemplate,
  manualTriggerScope,
  safeRegexTest,
  tenantEmailTriggerScope,
  EMAIL_ATTACHMENT_NAMES_MAX,
  webhookTriggerScope,
  EMAIL_THREAD_REPLY_MARKER
} from "@/lib/ai-flows/trigger-eval";

describe("firstUrlInText", () => {
  it("finds a url and trims trailing punctuation", () => {
    expect(firstUrlInText("see https://rfrl.to/abc123.")).toBe("https://rfrl.to/abc123");
  });
  it("returns null when no url present", () => {
    expect(firstUrlInText("no link here")).toBeNull();
  });
});

describe("safeRegexTest", () => {
  it("matches case-insensitively by default and respects the flag", () => {
    expect(safeRegexTest("LEAD", "new lead", undefined)).toBe(true);
    expect(safeRegexTest("LEAD", "new lead", false)).toBe(false);
  });
  it("never throws on an invalid pattern", () => {
    expect(safeRegexTest("([", "anything")).toBe(false);
  });
});

describe("evaluateTriggerConditions", () => {
  const text = "New referral: https://rfrl.to/x from Jane";
  it("ANDs all conditions; empty list matches everything", () => {
    expect(evaluateTriggerConditions([], text, "a@b.c")).toBe(true);
    expect(
      evaluateTriggerConditions(
        [
          { type: "contains", value: "REFERRAL" },
          { type: "has_url" },
          { type: "from_matches", value: "@b.c" }
        ],
        text,
        "jane@b.c"
      )
    ).toBe(true);
    expect(
      evaluateTriggerConditions([{ type: "contains", value: "nope" }, { type: "has_url" }], text, "")
    ).toBe(false);
  });
  it("supports regex and case-sensitive contains", () => {
    expect(evaluateTriggerConditions([{ type: "regex", value: "rfrl\\.to/\\w+" }], text, "")).toBe(
      true
    );
    expect(
      evaluateTriggerConditions(
        [{ type: "contains", value: "REFERRAL", caseInsensitive: false }],
        text,
        ""
      )
    ).toBe(false);
  });
  it("from_matches tests the sender, not the text", () => {
    expect(evaluateTriggerConditions([{ type: "from_matches", value: "jane" }], text, "bob@x.y")).toBe(
      false
    );
  });
  it("matches a from_matches contact ref against pre-resolved identity values", () => {
    const ref = { source: "employee" as const, id: "11111111-1111-4111-8111-111111111111" };
    const conditions = [{ type: "from_matches" as const, ref }];
    const refValues = new Map([
      ["employee:11111111-1111-4111-8111-111111111111", ["+16025551234", "dave@x.com"]]
    ]);
    expect(evaluateTriggerConditions(conditions, text, "dave@x.com", refValues)).toBe(true);
    expect(evaluateTriggerConditions(conditions, text, "bob@x.y", refValues)).toBe(false);
    // No pre-resolved entry (deleted person / resolution failure) fails closed.
    expect(evaluateTriggerConditions(conditions, text, "dave@x.com")).toBe(false);
  });
  it("fails a from_matches with neither value nor ref (malformed row)", () => {
    const conditions = [{ type: "from_matches" }] as unknown as Parameters<
      typeof evaluateTriggerConditions
    >[0];
    expect(evaluateTriggerConditions(conditions, text, "dave@x.com")).toBe(false);
  });

  // ── Production pin: Privyr digest emails must never start a lead flow ────
  // On 2026-07-11 a Privyr "Daily Client Summary" email started Truly's
  // lead-intake flow (its subject contains "new leads"), which extracted a
  // garbage phone and burned five Telnyx 40310 retries. The tightened
  // trigger set (from lead-forwarding@ + "new lead"; from alerts-noreply@ +
  // "new lead:") lets both real lead-alert shapes through and rejects the
  // digest. These are Truly's EXACT production conditions and the real
  // email shapes — if trigger matching semantics drift, this fails first.
  describe("Truly Privyr trigger set vs real Privyr email shapes", () => {
    const primary = [
      { type: "from_matches" as const, value: "lead-forwarding@privyr.com" },
      { type: "contains" as const, value: "new lead", caseInsensitive: true }
    ];
    const secondary = [
      { type: "from_matches" as const, value: "alerts-noreply@privyr.com" },
      { type: "contains" as const, value: "new lead:", caseInsensitive: true }
    ];
    const leadForwarding =
      "New Lead: Fah\nCongrats! You've received a new lead from Muhammad Fahad " +
      "Lead via Privyr Lead Forms - Auto Lead Name: Fah Phone: +14164560696";
    const leadAlert =
      "New Lead: Fahad\nCongrats! You have a new lead from Muhammad Fahad " +
      "Lead via Privyr Lead Forms - Auto Lead Name: Fahad Phone: +14164560696";
    const dailySummary =
      "Daily Client Summary: 31 new leads, 5 uncontacted leads\n" +
      "Daily Summary for Leads Upcoming Activities No follow-ups due " +
      "5 uncontacted leads Last 24 hours 31 new leads received " +
      "UNCONTACTED LEADS There are 5 leads that you haven't contacted yet: Shahid";

    it("a forwarded lead matches the primary trigger", () => {
      expect(
        evaluateTriggerConditions(primary, leadForwarding, "lead-forwarding@privyr.com")
      ).toBe(true);
    });
    it("a lead alert matches the secondary trigger", () => {
      expect(evaluateTriggerConditions(secondary, leadAlert, "alerts-noreply@privyr.com")).toBe(
        true
      );
    });
    it("the daily digest matches NEITHER trigger despite containing 'new leads'", () => {
      expect(
        evaluateTriggerConditions(primary, dailySummary, "alerts-noreply@privyr.com")
      ).toBe(false);
      expect(
        evaluateTriggerConditions(secondary, dailySummary, "alerts-noreply@privyr.com")
      ).toBe(false);
    });
  });
});

describe("htmlToText", () => {
  it("strips tags/scripts and decodes entities without double-unescaping", () => {
    const html =
      "<html><style>p{}</style><script>x()</script><p>Hi&nbsp;there &amp;lt; you</p></html>";
    expect(htmlToText(html)).toBe("Hi there &lt; you");
  });

  it("drops head/title/comment CONTENTS (no CSS or merge-tag leakage)", () => {
    const html =
      "<!--[if mso]><style>.m{color:red}</style><![endif]-->" +
      "<head><title>*|MC:SUBJECT|*</title><style>p{margin:10px 0;}</style></head>" +
      "<body><p>Real text</p></body>";
    expect(htmlToText(html)).toBe("Real text");
  });

  it("keeps http(s) link destinations as 'label (url)'", () => {
    expect(htmlToText('<a href="https://x.com/go?a=1">Accept</a>')).toBe(
      "Accept (https://x.com/go?a=1)"
    );
    // Non-http hrefs stay dropped.
    expect(htmlToText('<a href="mailto:a@b.com">mail</a>')).toBe("mail");
  });
});

describe("looksLikeStrippedTemplate", () => {
  it("flags an unrendered merge tag or 3+ CSS blocks", () => {
    expect(looksLikeStrippedTemplate("*|MC:SUBJECT|* hello")).toBe(true);
    expect(
      looksLikeStrippedTemplate(
        "p{ margin:0; x:1; }\ntable{ a:b; c:d; }\nimg{ e:f; g:h; }\nUse code 1234."
      )
    ).toBe(true);
  });

  it("does not flag prose or a couple of incidental braces", () => {
    expect(looksLikeStrippedTemplate("Hi, your appointment is Friday 2pm.")).toBe(false);
    expect(looksLikeStrippedTemplate("config { a:1; b:2; } and { c:3; d:4; }")).toBe(false);
  });
});

describe("manualTriggerScope", () => {
  it("extracts the url and stamps the starter", () => {
    expect(manualTriggerScope("  check https://x.com/lead  ", "owner@biz.com")).toEqual({
      channel: "manual",
      windowText: "check https://x.com/lead",
      url: "https://x.com/lead",
      from: "owner@biz.com"
    });
  });
  it("handles empty input", () => {
    expect(manualTriggerScope("", "owner@biz.com")).toEqual({
      channel: "manual",
      windowText: "",
      url: null,
      from: "owner@biz.com"
    });
  });
});

describe("emailTriggerScope", () => {
  it("combines subject + body, finds the url, and keeps provenance", () => {
    const scope = emailTriggerScope({
      id: "m1",
      fromEmail: "leads@referralexchange.com",
      subject: "New lead",
      bodyText: "Open https://rfrl.to/abc",
      receivedAt: "2026-06-09T15:00:00Z"
    });
    expect(scope).toEqual({
      channel: "email",
      windowText: "New lead\nOpen https://rfrl.to/abc",
      url: "https://rfrl.to/abc",
      from: "leads@referralexchange.com",
      subject: "New lead",
      message_id: "m1",
      received_at: "2026-06-09T15:00:00Z",
      // Always present, never omitted: a step branching on it must be able to
      // tell "we have not replied" from "the poller did not look".
      thread_has_our_reply: "no",
      // No To/Cc on this fixture, so there is nobody else on the mail.
      others_to: "",
      others_cc: ""
    });
  });

  it("splits the prospect out of the recipients, dropping us and the sender", () => {
    /**
     * The Aug 8 referral: addressed to our team alias and the prospect, with
     * the introducer in From. Writing to the prospect DIRECTLY needs their
     * address on its own, which a reply-all cannot give you.
     */
    const scope = emailTriggerScope(
      {
        id: "m11",
        fromEmail: "james@kypads.com",
        subject: "Referral for Bobby",
        bodyText: "Meet Bobby.",
        toRecipients: '"team@newcoworker.com" <team@newcoworker.com>, bobby@bobbyjobs.example.com',
        ccRecipients: "Assistant <assistant@kypads.com>, newcoworkerteam@gmail.com"
      },
      { selfEmail: "newcoworkerteam@gmail.com" }
    );
    // team@ is on the tenant domain and newcoworkerteam@ is the account, so
    // both drop; the sender drops; display names are stripped.
    expect(scope.others_to).toBe("bobby@bobbyjobs.example.com");
    expect(scope.others_cc).toBe("assistant@kypads.com");
  });

  it("reports nobody else when only we and the sender are on it", () => {
    // The Example B case. An empty others_to is what lets the send step skip.
    const scope = emailTriggerScope(
      {
        id: "m12",
        fromEmail: "james@kypads.com",
        subject: "Referral for Bobby",
        bodyText: "Meet Bobby.",
        toRecipients: "team@newcoworker.com"
      },
      { selfEmail: "newcoworkerteam@gmail.com" }
    );
    expect(scope.others_to).toBe("");
    expect(scope.others_cc).toBe("");
  });

  it("never lists one person twice across To and Cc", () => {
    const scope = emailTriggerScope(
      {
        id: "m13",
        fromEmail: "james@kypads.com",
        subject: "s",
        bodyText: "b",
        toRecipients: "bobby@x.com",
        ccRecipients: "Bobby <BOBBY@x.com>, carol@y.com"
      },
      { selfEmail: "newcoworkerteam@gmail.com" }
    );
    expect(scope.others_to).toBe("bobby@x.com");
    expect(scope.others_cc).toBe("carol@y.com");
  });

  it("marks a message on a conversation we have already replied to", () => {
    /**
     * The signal that would have saved the OAuth email (Aug 9 2026): Google
     * acknowledging our OWN verification request, on a thread Brian had
     * replied to on Jul 30, filed as routine and binned. Being in the
     * conversation does not depend on how the sender words the subject.
     */
    const scope = emailTriggerScope({
      id: "m9",
      fromEmail: "api-oauth-dev-verification@google.com",
      subject: "[Action Needed] OAuth Verification Request Acknowledgement",
      bodyText: "We have received your request.",
      threadId: "t-9",
      weRepliedOnThread: true
    });
    expect(scope.thread_has_our_reply).toBe("yes");
    // In windowText too, because `classify` reads windowText and its question
    // is not templated, so this is the only path to the model.
    expect(scope.windowText).toContain(EMAIL_THREAD_REPLY_MARKER);
    // AFTER the body, so a long message cannot clip the marker away.
    expect(String(scope.windowText).trimEnd().endsWith(EMAIL_THREAD_REPLY_MARKER)).toBe(true);
  });

  it("says nothing extra when we have never replied on the thread", () => {
    const scope = emailTriggerScope({
      id: "m10",
      fromEmail: "news@vendor.com",
      subject: "Monthly roundup",
      bodyText: "Lots of news.",
      threadId: "t-10"
    });
    expect(scope.thread_has_our_reply).toBe("no");
    expect(scope.windowText).not.toContain(EMAIL_THREAD_REPLY_MARKER);
  });
  it("clips oversized bodies and omits received_at when unknown", () => {
    const scope = emailTriggerScope({
      id: "m2",
      fromEmail: "a@b.c",
      subject: "s",
      bodyText: "x".repeat(EMAIL_WINDOW_TEXT_MAX + 500)
    });
    expect(scope.windowText.length).toBe(EMAIL_WINDOW_TEXT_MAX);
    expect("received_at" in scope).toBe(false);
  });

  it("carries the watched mailbox connection_id for organize steps", () => {
    const scope = emailTriggerScope(
      {
        id: "m3",
        fromEmail: "a@b.c",
        subject: "s",
        bodyText: "body"
      },
      { connectionId: "16cff2b9-b4d3-421c-b25d-b40edd80c9a8" }
    );
    expect(scope.connection_id).toBe("16cff2b9-b4d3-421c-b25d-b40edd80c9a8");
  });

  it("carries the provider thread id so a notify step can cool down per conversation", () => {
    const scope = emailTriggerScope({
      id: "m4",
      fromEmail: "james@kypads.com",
      subject: "Re: Introductions",
      bodyText: "body",
      threadId: "199abc4d5e6f7890"
    });
    expect(scope.thread_id).toBe("199abc4d5e6f7890");
  });

  it("OMITS thread_id rather than emitting an empty one", () => {
    // A blank key must not become a shared cooldown bucket that silences
    // every alert after the first; absent means "no cooldown for this run".
    for (const threadId of [undefined, ""]) {
      const scope = emailTriggerScope({
        id: "m5",
        fromEmail: "a@b.c",
        subject: "s",
        bodyText: "body",
        ...(threadId === undefined ? {} : { threadId })
      });
      expect("thread_id" in scope).toBe(false);
    }
  });
});

describe("tenantEmailTriggerScope", () => {
  it("tags the tenant_email channel and keeps the recipient + provenance", () => {
    const scope = tenantEmailTriggerScope({
      id: "m1",
      fromEmail: "jane@example.com",
      subject: "New lead",
      bodyText: "Open https://rfrl.to/abc",
      toEmail: "amy@newcoworker.com",
      receivedAt: "2026-06-09T15:00:00Z"
    });
    expect(scope).toEqual({
      channel: "tenant_email",
      windowText: "New lead\nOpen https://rfrl.to/abc",
      url: "https://rfrl.to/abc",
      from: "jane@example.com",
      subject: "New lead",
      message_id: "m1",
      to: "amy@newcoworker.com",
      received_at: "2026-06-09T15:00:00Z",
      image: "",
      document: "",
      document_name: "",
      attachments: "",
      attachment_count: 0
    });
  });
  it("omits to and received_at when unknown", () => {
    const scope = tenantEmailTriggerScope({
      id: "m2",
      fromEmail: "a@b.c",
      subject: "s",
      bodyText: "body"
    });
    expect("to" in scope).toBe(false);
    expect("received_at" in scope).toBe(false);
  });
  it("carries the first image attachment ref as {{trigger.image}}", () => {
    const scope = tenantEmailTriggerScope({
      id: "m3",
      fromEmail: "a@b.c",
      subject: "photo",
      bodyText: "see attached",
      imageRef: "email-attachments:inbound/m3/face.jpg"
    });
    expect(scope.image).toBe("email-attachments:inbound/m3/face.jpg");
  });
  it("carries the first document attachment as {{trigger.document}} + its filename", () => {
    const scope = tenantEmailTriggerScope({
      id: "m4",
      fromEmail: "a@b.c",
      subject: "renewal",
      bodyText: "see attached",
      documentRef: "email-attachments:inbound/m4/0-renewal.pdf",
      documentName: "renewal.pdf"
    });
    expect(scope.document).toBe("email-attachments:inbound/m4/0-renewal.pdf");
    expect(scope.document_name).toBe("renewal.pdf");
  });

  it("appends the attachments line AFTER the body slice and exposes {{trigger.attachments}}", () => {
    const scope = tenantEmailTriggerScope({
      id: "m4",
      fromEmail: "a@b.c",
      subject: "docs",
      // A body at the window cap would truncate an in-body line away — the
      // attachments line must survive it.
      bodyText: "x".repeat(EMAIL_WINDOW_TEXT_MAX),
      attachmentNames: ["license.pdf", "  proof of address.pdf  ", ""]
    });
    expect(
      scope.windowText.endsWith("\n\n[inbound attachments] license.pdf, proof of address.pdf")
    ).toBe(true);
    // The starter template's anchored trigger regex matches the appended line.
    expect(/\n\[inbound attachments\] .+$/.test(scope.windowText)).toBe(true);
    expect(scope.attachments).toBe("license.pdf, proof of address.pdf");
    expect(scope.attachment_count).toBe(2);
  });

  it("adds no attachments line when every name is blank", () => {
    const scope = tenantEmailTriggerScope({
      id: "m5",
      fromEmail: "a@b.c",
      subject: "s",
      bodyText: "body",
      attachmentNames: ["  ", ""]
    });
    expect(scope.windowText).toBe("s\nbody");
    expect(scope.attachments).toBe("");
    expect(scope.attachment_count).toBe(0);
  });

  it("caps a pathological attachment-names line", () => {
    const scope = tenantEmailTriggerScope({
      id: "m6",
      fromEmail: "a@b.c",
      subject: "s",
      bodyText: "body",
      attachmentNames: Array.from({ length: 100 }, (_, i) => `${"long".repeat(10)}-${i}.pdf`)
    });
    expect((scope.attachments as string).length).toBe(EMAIL_ATTACHMENT_NAMES_MAX);
  });
});

describe("flattenWebhookPayload", () => {
  it("renders scalars as key: value lines, nesting with dotted paths", () => {
    expect(
      flattenWebhookPayload({
        full_name: "Jane Lead",
        phone_number: "+16025551234",
        field_data: { city: "Phoenix", budget: 500000 },
        tags: ["buyer", "urgent"]
      })
    ).toBe(
      [
        "full_name: Jane Lead",
        "phone_number: +16025551234",
        "field_data.city: Phoenix",
        "field_data.budget: 500000",
        "tags.0: buyer",
        "tags.1: urgent"
      ].join("\n")
    );
  });
  it("skips null/undefined values and caps total size", () => {
    expect(flattenWebhookPayload({ a: null, b: undefined, c: "x" })).toBe("c: x");
    const big = flattenWebhookPayload({ text: "y".repeat(EMAIL_WINDOW_TEXT_MAX + 500) });
    expect(big.length).toBe(EMAIL_WINDOW_TEXT_MAX);
  });
  it("bounds hostile payloads: deep nesting and huge key counts stop early", () => {
    // 6 levels deep — beyond the depth bound, so the innermost leaf is dropped.
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    expect(flattenWebhookPayload(deep)).toBe("");
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) wide[`k${i}`] = i;
    const lines = flattenWebhookPayload(wide).split("\n");
    expect(lines.length).toBeLessThanOrEqual(201);
  });
});

describe("webhookTriggerScope", () => {
  it("tags the webhook channel, flattens the payload, and finds the url", () => {
    const scope = webhookTriggerScope({
      source: "facebook_lead_ads",
      eventId: "lead-123",
      data: { full_name: "Jane", link: "https://fb.me/lead/1" }
    });
    expect(scope).toEqual({
      channel: "webhook",
      windowText: "full_name: Jane\nlink: https://fb.me/lead/1",
      url: "https://fb.me/lead/1",
      from: "facebook_lead_ads",
      event_id: "lead-123",
      // Named keys too, so a step can say {{trigger.full_name}} instead of
      // digging the value back out of the flattened blob.
      full_name: "Jane",
      link: "https://fb.me/lead/1"
    });
  });
  it("omits event_id when unknown and bounds the source label", () => {
    const scope = webhookTriggerScope({ source: "s".repeat(200), data: { a: 1 } });
    expect("event_id" in scope).toBe(false);
    expect(scope.from.length).toBe(120);
  });

  it("publishes an Instagram comment's fields under their own names", () => {
    // This is what makes reply_to_comment default to the right comment.
    const scope = webhookTriggerScope({
      source: "instagram_comment",
      eventId: "c-1",
      data: {
        comment_id: "c-1",
        comment_text: "how much?",
        username: "buyer",
        media_id: "m-9"
      }
    });
    expect(scope.comment_id).toBe("c-1");
    expect(scope.comment_text).toBe("how much?");
    expect(scope.username).toBe("buyer");
    expect(scope.media_id).toBe("m-9");
  });

  it("never lets a payload key overwrite what the trigger actually was", () => {
    // A hostile (or just careless) bridge payload carrying its own "channel"
    // or "from" must not be able to rewrite the trigger's identity, which
    // from_matches conditions and the engine both key on.
    const scope = webhookTriggerScope({
      source: "facebook_lead_ads",
      eventId: "real-id",
      data: {
        channel: "email",
        from: "somewhere_else",
        url: "https://evil.test",
        windowText: "spoofed",
        event_id: "spoofed-id"
      }
    });
    expect(scope.channel).toBe("webhook");
    expect(scope.from).toBe("facebook_lead_ads");
    expect(scope.event_id).toBe("real-id");
    expect(scope.windowText).toContain("spoofed");
    expect(scope.url).toBe("https://evil.test");
  });

  it("promotes only scalars under plain names, and truncates long values", () => {
    const scope = webhookTriggerScope({
      source: "bridge",
      data: {
        nested: { deep: "value" },
        list: [1, 2],
        nothing: null,
        count: 7,
        flag: true,
        "dotted.key": "unreachable",
        "spaced key": "unreachable",
        long: "x".repeat(900)
      }
    });
    // Numbers and booleans render as strings; objects, arrays, and null are
    // left to the flattened blob.
    expect(scope.count).toBe("7");
    expect(scope.flag).toBe("true");
    expect("nested" in scope).toBe(false);
    expect("list" in scope).toBe(false);
    expect("nothing" in scope).toBe(false);
    // `{{trigger.x}}` cannot address these, so promoting them is dead weight.
    expect("dotted.key" in scope).toBe(false);
    expect("spaced key" in scope).toBe(false);
    expect((scope.long as string).length).toBe(500);
  });

  it("caps how many payload keys a hostile payload can add", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) many[`k${i}`] = `v${i}`;
    const scope = webhookTriggerScope({ source: "bridge", eventId: "e", data: many });
    // 40 payload keys, plus the five the scope always carries.
    expect(Object.keys(scope).length).toBe(45);
    expect(scope.k0).toBe("v0");
    expect("k40" in scope).toBe(false);
  });
});

describe("calendarEventText", () => {
  it("renders every populated field as a labeled line, stripping description html", () => {
    const text = calendarEventText({
      id: "e1",
      title: "Roof estimate",
      description: "<p>Bring&nbsp;ladder</p>",
      location: "12 Main St",
      organizerEmail: "owner@biz.com",
      attendees: ["Jane <jane@x.com>", "bare@x.com"],
      startIso: "2026-07-09T14:00:00Z",
      endIso: "2026-07-09T15:00:00Z",
      calendar: "shared"
    });
    expect(text).toBe(
      [
        "title: Roof estimate",
        "starts: 2026-07-09T14:00:00Z",
        "ends: 2026-07-09T15:00:00Z",
        "location: 12 Main St",
        "organizer: owner@biz.com",
        "attendee: Jane <jane@x.com>",
        "attendee: bare@x.com",
        "description: Bring ladder"
      ].join("\n")
    );
  });
  it("keeps only the title line for a bare event", () => {
    expect(calendarEventText({ id: "e1", title: "Solo", calendar: "primary" })).toBe(
      "title: Solo"
    );
  });
});

describe("calendarTriggerScope", () => {
  it("tags the calendar channel and carries the event metadata keys", () => {
    const scope = calendarTriggerScope({
      id: "e1",
      title: "Estimate",
      description: "Details at https://leads.example/1",
      organizerEmail: "owner@biz.com",
      startIso: "2026-07-09T14:00:00Z",
      endIso: "2026-07-09T15:00:00Z",
      calendar: "primary"
    });
    expect(scope).toEqual({
      channel: "calendar",
      windowText:
        "title: Estimate\nstarts: 2026-07-09T14:00:00Z\nends: 2026-07-09T15:00:00Z\n" +
        "organizer: owner@biz.com\ndescription: Details at https://leads.example/1",
      url: "https://leads.example/1",
      from: "owner@biz.com",
      event_id: "e1",
      event_title: "Estimate",
      calendar: "primary",
      starts_at: "2026-07-09T14:00:00Z",
      ends_at: "2026-07-09T15:00:00Z"
    });
  });
  it("defaults from to empty, omits absent times, and bounds the title", () => {
    const scope = calendarTriggerScope({
      id: "e2",
      title: "t".repeat(400),
      calendar: "shared"
    });
    expect(scope.from).toBe("");
    expect(scope.url).toBeNull();
    expect("starts_at" in scope).toBe(false);
    expect("ends_at" in scope).toBe(false);
    expect((scope.event_title as string).length).toBe(300);
  });
  it("caps windowText at the shared max", () => {
    const scope = calendarTriggerScope({
      id: "e3",
      title: "big",
      description: "x".repeat(EMAIL_WINDOW_TEXT_MAX + 100),
      calendar: "primary"
    });
    expect(scope.windowText.length).toBe(EMAIL_WINDOW_TEXT_MAX);
  });
});
