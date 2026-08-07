import { describe, expect, it } from "vitest";
import {
  coerceEmailsViewFilter,
  emailListFiltersFromView,
  parseEmailsViewFilter,
  withLinkedEmailRow
} from "@/lib/dashboard/email-filters";

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
    expect(emailListFiltersFromView({ view: "all" })).toEqual({ limit: 100 });
    expect(emailListFiltersFromView({ view: "sent" })).toEqual({
      limit: 100,
      direction: "outbound"
    });
    expect(emailListFiltersFromView({ view: "received" })).toEqual({
      limit: 100,
      direction: "inbound"
    });
    expect(emailListFiltersFromView({ view: "inbox" })).toEqual({
      limit: 100,
      inbox: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "archived" })).toEqual({
      limit: 100,
      inbox: false,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "unread" })).toEqual({
      limit: 100,
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
      folder: "Sales",
      label: "VIP",
      direction: "inbound",
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(
      emailListFiltersFromView({ view: "archived", folder: "Sales" })
    ).toEqual({
      limit: 100,
      folder: "Sales",
      inbox: false,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "sent", folder: "Sales" })).toEqual({
      limit: 100,
      folder: "Sales",
      direction: "outbound",
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "unread", folder: "Sales" })).toEqual({
      limit: 100,
      folder: "Sales",
      unreadOnly: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "all", folder: "Sales" })).toEqual({
      limit: 100,
      folder: "Sales",
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(
      emailListFiltersFromView({ view: "received", folder: "Sales" })
    ).toEqual({
      limit: 100,
      folder: "Sales",
      direction: "inbound",
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
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
