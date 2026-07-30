import { describe, expect, it } from "vitest";
import {
  coerceEmailsViewFilter,
  emailListFiltersFromView,
  parseEmailsViewFilter
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
      inbox: true
    });
    expect(emailListFiltersFromView({ view: "archived" })).toEqual({
      limit: 100,
      inbox: false
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
      direction: "inbound"
    });
    expect(
      emailListFiltersFromView({ view: "archived", folder: "Sales" })
    ).toEqual({
      limit: 100,
      folder: "Sales",
      inbox: false
    });
    expect(emailListFiltersFromView({ view: "sent", folder: "Sales" })).toEqual({
      limit: 100,
      folder: "Sales",
      direction: "outbound"
    });
    expect(emailListFiltersFromView({ view: "unread", folder: "Sales" })).toEqual({
      limit: 100,
      folder: "Sales",
      unreadOnly: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(emailListFiltersFromView({ view: "all", folder: "Sales" })).toEqual({
      limit: 100,
      folder: "Sales"
    });
    expect(
      emailListFiltersFromView({ view: "received", folder: "Sales" })
    ).toEqual({
      limit: 100,
      folder: "Sales",
      direction: "inbound"
    });
  });
});
