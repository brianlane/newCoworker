/**
 * Owner alert copy for an email to a contact that did not arrive
 * (src/lib/email/templates/contact-email-bounce-alert.ts).
 *
 * The motivating case is a lead who booked with a work address whose mailbox
 * did not exist while a working phone and a different email sat on the
 * contact. The copy is judged on whether the owner can act from it alone.
 */
import { describe, expect, it } from "vitest";
import { buildContactEmailBounceAlert } from "@/lib/email/templates/contact-email-bounce-alert";
import es from "../messages/es.json";

const base = {
  status: "bounced" as const,
  errorCode: "Permanent",
  contactName: "Benjamin Dobrzynski",
  address: "benjamin@dead.example",
  emailSubject: "Confirmed: Strategy Call with Liz at Vantage Flow Media",
  phone: "+13023538730",
  otherEmail: "b_dobrzynski@hotmail.example"
};

describe("buildContactEmailBounceAlert", () => {
  it("tells the owner what did not arrive, why, and how else to reach the person", () => {
    const copy = buildContactEmailBounceAlert(base);
    expect(copy.subject).toBe(
      "Email to Benjamin Dobrzynski did not arrive: benjamin@dead.example"
    );
    expect(copy.heading).toBe("An email to Benjamin Dobrzynski did not arrive");
    expect(copy.body).toContain(
      'emailed Benjamin Dobrzynski at benjamin@dead.example ("Confirmed: Strategy Call with Liz at Vantage Flow Media")'
    );
    expect(copy.body).toContain("the mailbox does not exist or is closed");
    expect(copy.body).toContain("Phone: (302) 353-8730");
    expect(copy.body).toContain("Another address on their record: b_dobrzynski@hotmail.example");
    // The consequence the motivating case actually had: the calendar invite
    // went to the same dead address, so the lead had nothing but our text.
    expect(copy.body).toContain("calendar invite");
    expect(copy.body).toContain("Anything else sent to benjamin@dead.example will fail the same way");
    // Paragraphs are separated by blank lines for the dispatcher's renderer.
    expect(copy.body.split("\n\n").length).toBeGreaterThanOrEqual(4);
    expect(copy.summaryLine).toBe(
      "Email to Benjamin Dobrzynski did not arrive (benjamin@dead.example)"
    );
  });

  it("points the button at the contact page when there is a phone, else at the emails page", () => {
    const withPhone = buildContactEmailBounceAlert(base);
    expect(withPhone.ctaLabel).toBe("Open contact");
    expect(withPhone.ctaPath).toBe("/dashboard/customers/%2B13023538730");

    const noPhone = buildContactEmailBounceAlert({ ...base, phone: null });
    expect(noPhone.ctaLabel).toBe("Open emails");
    expect(noPhone.ctaPath).toBe("/dashboard/emails");
    expect(noPhone.body).not.toContain("Phone:");
  });

  it("puts the phone in the SMS when there is one, so the owner can act from the text alone", () => {
    expect(buildContactEmailBounceAlert(base).smsBody).toBe(
      "New Coworker Alert: our email to Benjamin Dobrzynski at benjamin@dead.example did not arrive (address rejected it). Reach them at (302) 353-8730 instead."
    );
    expect(buildContactEmailBounceAlert({ ...base, phone: "  " }).smsBody).toBe(
      "New Coworker Alert: our email to Benjamin Dobrzynski at benjamin@dead.example did not arrive (address rejected it). Reach them another way."
    );
  });

  it("drops the alternate-address line when there is none, never suggesting the dead address", () => {
    const copy = buildContactEmailBounceAlert({ ...base, otherEmail: null });
    expect(copy.body).not.toContain("Another address");
    expect(buildContactEmailBounceAlert({ ...base, otherEmail: "  " }).body).not.toContain(
      "Another address"
    );
    // Both detail lines absent: no empty paragraph is left behind.
    const bare = buildContactEmailBounceAlert({ ...base, otherEmail: null, phone: null });
    expect(bare.body).not.toMatch(/\n\n\n/);
  });

  it("says something different for each failure shape", () => {
    // Transient: Resend gave up after repeated refusals; the mailbox may exist.
    expect(buildContactEmailBounceAlert({ ...base, errorCode: "Transient" }).body).toContain(
      "refused it repeatedly"
    );
    // Unknown classification reads as the hard bounce it almost always is.
    expect(buildContactEmailBounceAlert({ ...base, errorCode: null }).body).toContain(
      "does not accept mail"
    );
    // A complaint ARRIVED, so "their provider rejected it" would be false.
    const complained = buildContactEmailBounceAlert({ ...base, status: "complained" });
    expect(complained.body).toContain("reported it as spam");
    expect(complained.body).not.toContain("rejected it");
    // Failed: Resend could not send it at all.
    expect(buildContactEmailBounceAlert({ ...base, status: "failed" }).body).toContain(
      "could not be sent"
    );
  });

  it("survives a missing subject", () => {
    const copy = buildContactEmailBounceAlert({ ...base, emailSubject: null });
    expect(copy.body).toContain('at benjamin@dead.example ("")');
    expect(copy.subject).toContain("benjamin@dead.example");
  });

  it("renders the Spanish catalog when asked", () => {
    const copy = buildContactEmailBounceAlert({ ...base, locale: "es" });
    expect(copy.subject).toBe(es.emails.contactEmailBounceAlert.subject
      .replace("{name}", base.contactName)
      .replace("{address}", base.address));
    expect(copy.body).toContain("Teléfono: (302) 353-8730");
    expect(copy.ctaLabel).toBe("Abrir contacto");
  });

  it("never types an em dash or the British spelling", () => {
    for (const locale of ["en", "es"] as const) {
      const copy = buildContactEmailBounceAlert({ ...base, locale });
      const all = [copy.subject, copy.heading, copy.body, copy.smsBody, copy.ctaLabel].join("\n");
      expect(all).not.toContain("\u2014");
      expect(all.toLowerCase()).not.toContain("enquir");
    }
  });
});
