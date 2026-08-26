import { describe, expect, it } from "vitest";
import {
  coerceEmailsFiltersForMailbox,
  coerceEmailsViewFilter,
  emailListFiltersFromView,
  parseEmailsViewFilter,
  withLinkedEmailRow,
  emailsFiltersActive
} from "@/lib/dashboard/email-filters";
import {
  AI_MAILBOX_KEY,
  AI_MAILBOX_SOURCES,
  CONNECTED_MAILBOX_SOURCES
} from "@/lib/dashboard/email-mailbox";

/**
 * Platform alert mail is logged so its delivery receipt has somewhere to
 * land, but it is never correspondence, so EVERY view drops it. Asserted on
 * each expectation rather than stripped by a helper: a view that silently
 * stopped excluding it would bury the coworker's mail with customers under
 * the platform's own alerts.
 */
const NO_ALERTS = ["notification"];

describe("email-filters", () => {
  it("parses known views and defaults unknown values", () => {
    expect(parseEmailsViewFilter("inbox")).toBe("inbox");
    expect(parseEmailsViewFilter("nope")).toBe("all");
    expect(parseEmailsViewFilter(undefined)).toBe("all");
  });

  it("coerces Inbox+folder to Received", () => {
    expect(coerceEmailsViewFilter("inbox", "Sales")).toBe("received");
    expect(coerceEmailsViewFilter("inbox", "")).toBe("inbox");
    expect(coerceEmailsViewFilter("all", "Sales")).toBe("all");
  });

  it("maps each view chip onto listEmailLog options", () => {
    expect(emailListFiltersFromView({ view: "all" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS
    });
    expect(emailListFiltersFromView({ view: "sent" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      direction: "outbound"
    });
    expect(emailListFiltersFromView({ view: "received" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      direction: "inbound"
    });
    expect(emailListFiltersFromView({ view: "inbox" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      inbox: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "archived" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      inbox: false,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "unread" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      unreadOnly: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
  });

  it("lets a concrete folder win over the Inbox folder-null view", () => {
    expect(
      emailListFiltersFromView({
        view: "inbox",
        folder: "Sales",
        label: "VIP",
        limit: 50
      })
    ).toEqual({
      limit: 50,
      excludeSources: NO_ALERTS,
      folder: "Sales",
      label: "VIP",
      direction: "inbound",
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(
      emailListFiltersFromView({ view: "archived", folder: "Sales" })
    ).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      folder: "Sales",
      inbox: false,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "sent", folder: "Sales" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      folder: "Sales",
      direction: "outbound",
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "unread", folder: "Sales" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      folder: "Sales",
      unreadOnly: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "all", folder: "Sales" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      folder: "Sales",
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(
      emailListFiltersFromView({ view: "received", folder: "Sales" })
    ).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      folder: "Sales",
      direction: "inbound",
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
  });

  it("narrows the fetch to the selected mailbox", () => {
    expect(emailListFiltersFromView({ view: "all", mailbox: AI_MAILBOX_KEY })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      sources: AI_MAILBOX_SOURCES
    });
    expect(emailListFiltersFromView({ view: "sent", mailbox: "conn-1" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      direction: "outbound",
      sources: CONNECTED_MAILBOX_SOURCES
    });
  });

  it("intersects the mailbox sources with a view that pins its own", () => {
    // Inbox is already AI-mailbox-only; the AI chip must not widen it.
    expect(emailListFiltersFromView({ view: "inbox", mailbox: AI_MAILBOX_KEY })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      inbox: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
  });

  it("never widens to every source when the two filters cannot overlap", () => {
    // A hand-typed ?view=inbox&mailbox=<connection> has no possible rows. The
    // empty intersection must not read as "no source filter", which would show
    // the other mailbox's mail under a connected-mailbox chip.
    expect(emailListFiltersFromView({ view: "inbox", mailbox: "conn-1" })).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      inbox: true,
      sources: CONNECTED_MAILBOX_SOURCES
    });
    expect(
      emailListFiltersFromView({ view: "all", folder: "Sales", mailbox: "conn-1" })
    ).toEqual({
      limit: 100,
      excludeSources: NO_ALERTS,
      folder: "Sales",
      sources: CONNECTED_MAILBOX_SOURCES
    });
  });
});

describe("coerceEmailsFiltersForMailbox", () => {
  it("leaves everything alone for All and the AI mailbox", () => {
    expect(
      coerceEmailsFiltersForMailbox({ view: "inbox", folder: "Sales", mailbox: "" })
    ).toEqual({ view: "inbox", folder: "Sales" });
    expect(
      coerceEmailsFiltersForMailbox({ view: "unread", folder: "", mailbox: AI_MAILBOX_KEY })
    ).toEqual({ view: "unread", folder: "" });
  });

  it("widens AI-only views when a connected mailbox is picked", () => {
    expect(
      coerceEmailsFiltersForMailbox({ view: "inbox", folder: "Sales", mailbox: "conn-1" })
    ).toEqual({ view: "received", folder: "" });
    expect(
      coerceEmailsFiltersForMailbox({ view: "archived", folder: "", mailbox: "conn-1" })
    ).toEqual({ view: "all", folder: "" });
    expect(
      coerceEmailsFiltersForMailbox({ view: "unread", folder: "", mailbox: "conn-1" })
    ).toEqual({ view: "all", folder: "" });
  });

  it("keeps direction views and only drops the folder", () => {
    expect(
      coerceEmailsFiltersForMailbox({ view: "sent", folder: "Sales", mailbox: "conn-1" })
    ).toEqual({ view: "sent", folder: "" });
  });
});

describe("withLinkedEmailRow", () => {
  /**
   * The SMS alert links to one message by id. The page lists only the newest
   * 100 rows and the reading pane resolves its selection against that array,
   * so without this a link tapped days later opens the page to nothing.
   */
  const row = (id: string) => ({ id });

  it("prepends a linked row the list query missed", () => {
    // Age, or a view whose source filter excludes it: either way it is absent.
    expect(withLinkedEmailRow([row("a"), row("b")], row("z"))).toEqual([
      row("z"),
      row("a"),
      row("b")
    ]);
  });

  it("leaves a row already in the list exactly where it is", () => {
    // Prepending a duplicate would reorder the list and collide React keys.
    const rows = [row("a"), row("b"), row("c")];
    expect(withLinkedEmailRow(rows, row("b"))).toEqual(rows);
  });

  it("returns the list untouched when nothing was linked", () => {
    const rows = [row("a")];
    expect(withLinkedEmailRow(rows, null)).toBe(rows);
    expect(withLinkedEmailRow(rows, undefined)).toBe(rows);
  });

  it("handles an empty list, which is the case the deep link exists for", () => {
    expect(withLinkedEmailRow([], row("z"))).toEqual([row("z")]);
  });
});

describe("emailsFiltersActive", () => {
  /**
   * The predicate behind the Emails page's empty state. It decides whether the
   * filter controls render at all, and whether "no rows" reads as "no mail" or
   * "no mail matching this filter".
   *
   * The bug it fixes: the controls were gated on the row count, so a filter
   * with no results hid the buttons needed to escape it. `?view=inbox&mailbox=ai`
   * hit that on a live account, because Inbox is an AI-mailbox-only view and
   * that mailbox was empty while the connected Gmail had plenty.
   */
  it("is false only for the unfiltered default", () => {
    expect(emailsFiltersActive({ view: "all" })).toBe(false);
    expect(emailsFiltersActive({ view: "all", folder: "", label: "", mailbox: "" })).toBe(false);
  });

  it("is true for the combination that produced the dead end", () => {
    expect(emailsFiltersActive({ view: "inbox", mailbox: AI_MAILBOX_KEY })).toBe(true);
  });

  it.each([
    ["a non-default view", { view: "unread" as const }],
    ["a folder", { view: "all" as const, folder: "Receipts" }],
    ["a label", { view: "all" as const, label: "HQ/Automated" }],
    ["a mailbox", { view: "all" as const, mailbox: "16cff2b9-b4d3-421c-b25d-b40edd80c9a8" }]
  ])("is true for %s on its own", (_label, input) => {
    expect(emailsFiltersActive(input)).toBe(true);
  });

  it("ignores whitespace-only values, which are not a narrowing", () => {
    // A blank query param is not a filter, and treating it as one would keep
    // the chips on screen for a business with no email at all.
    expect(emailsFiltersActive({ view: "all", folder: "   ", label: " ", mailbox: "  " })).toBe(
      false
    );
  });
});
