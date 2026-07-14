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
  webhookTriggerScope
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
      received_at: "2026-06-09T15:00:00Z"
    });
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
      image: ""
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
      event_id: "lead-123"
    });
  });
  it("omits event_id when unknown and bounds the source label", () => {
    const scope = webhookTriggerScope({ source: "s".repeat(200), data: { a: 1 } });
    expect("event_id" in scope).toBe(false);
    expect(scope.from.length).toBe(120);
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
