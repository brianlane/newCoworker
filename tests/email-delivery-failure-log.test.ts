import { describe, expect, it } from "vitest";
import { formatEmailDeliveryFailedLogMessage } from "@/lib/email/delivery-failure-log";

describe("formatEmailDeliveryFailedLogMessage", () => {
  it("says we cancelled the outreach follow-up when a pitch was retired", () => {
    expect(
      formatEmailDeliveryFailedLogMessage({
        status: "bounced",
        to: "info@example.com",
        retiredCount: 1
      })
    ).toBe(
      "Email was not delivered (bounced) to info@example.com. Outreach follow-up cancelled; this address will not be mailed again."
    );
  });

  it("does not quote Resend's mailing-list advice", () => {
    const message = formatEmailDeliveryFailedLogMessage({
      status: "bounced",
        to: "info@example.com",
      retiredCount: 1
    });
    expect(message.toLowerCase()).not.toContain("mailing list");
    expect(message.toLowerCase()).not.toContain("we recommend");
  });

  it("names a bounce that was not an outreach pitch", () => {
    expect(
      formatEmailDeliveryFailedLogMessage({
        status: "bounced",
        to: "owner@example.com",
        retiredCount: 0
      })
    ).toBe("Email was not delivered (bounced) to owner@example.com.");
  });

  it("names a failure with no recipient", () => {
    expect(
      formatEmailDeliveryFailedLogMessage({
        status: "failed",
        to: null,
        retiredCount: 0
      })
    ).toBe("Email was not delivered (failed).");
  });

  it("keeps complaints as a delivery failure, not a retire", () => {
    expect(
      formatEmailDeliveryFailedLogMessage({
        status: "complained",
        to: null,
        retiredCount: 0
      })
    ).toBe("Email was not delivered (complained).");
  });

  it("still says when the receipt matched no logged send", () => {
    expect(
      formatEmailDeliveryFailedLogMessage({
        status: "bounced",
        to: "owner@example.com",
        retiredCount: 0,
        unattributed: true
      })
    ).toBe(
      "Email was not delivered (bounced) to owner@example.com. Matched no logged send."
    );
  });

  it("says the tenant was told when a customer-facing send bounced", () => {
    // The row then reads as handled on the admin feed: the person who can
    // reach the contact another way has been alerted, HQ has no action.
    expect(
      formatEmailDeliveryFailedLogMessage({
        status: "bounced",
        to: "lead@example.com",
        retiredCount: 0,
        ownerAlerted: true
      })
    ).toBe(
      "Email was not delivered (bounced) to lead@example.com. The account owner was alerted; nothing for HQ to do."
    );
    expect(
      formatEmailDeliveryFailedLogMessage({
        status: "bounced",
        to: "lead@example.com",
        retiredCount: 0,
        ownerAlerted: false
      })
    ).toBe("Email was not delivered (bounced) to lead@example.com.");
  });

  it("can retire an outreach pitch even when email_log did not match", () => {
    expect(
      formatEmailDeliveryFailedLogMessage({
        status: "bounced",
        to: "info@example.com",
        retiredCount: 1,
        unattributed: true
      })
    ).toBe(
      "Email was not delivered (bounced) to info@example.com. Outreach follow-up cancelled; this address will not be mailed again. Matched no logged send."
    );
  });
});
