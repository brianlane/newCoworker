import { describe, expect, it } from "vitest";
import {
  notificationMustBePhiFree,
  phiFreeNotificationCopy
} from "../supabase/functions/_shared/hipaa_notification_redaction";

describe("hipaa/notification-redaction", () => {
  describe("notificationMustBePhiFree", () => {
    it("redacts for a HIPAA tenant", () => {
      expect(notificationMustBePhiFree(true)).toBe(true);
    });

    it("sends content for a tenant we positively know is not HIPAA", () => {
      expect(notificationMustBePhiFree(false)).toBe(false);
    });

    it("FAILS CLOSED on an unknown tenant", () => {
      // undefined means the business row could not be read. A PHI disclosure
      // is a reportable breach that cannot be taken back; a generic alert
      // still tells the owner to go look.
      expect(notificationMustBePhiFree(undefined)).toBe(true);
    });
  });

  describe("phiFreeNotificationCopy", () => {
    const URL = "https://app.example.com/dashboard";

    it("is a fixed constant plus the dashboard link, with no interpolation slot", () => {
      // The function takes only a URL, so there is no channel through which
      // caller content could reach it. The proof that the DISPATCHER actually
      // uses this instead of the caller's copy lives in
      // tests/notifications-dispatch.test.ts.
      const copy = phiFreeNotificationCopy(URL);
      expect(copy.smsBody).toContain(URL);
      expect(copy.emailBody).toContain(URL);
      expect(copy.emailSubject).not.toContain(URL);
      expect(copy.summary).toBe(copy.emailHeading);
    });

    it("says out loud that the omission is deliberate", () => {
      // An owner who gets a contentless alert should not think it is a bug.
      expect(phiFreeNotificationCopy(URL).emailBody).toMatch(/deliberately|no patient information/i);
    });

    it("localizes to Spanish", () => {
      const es = phiFreeNotificationCopy(URL, "es");
      expect(es.emailSubject).toContain("atención");
      expect(es.smsBody).toContain(URL);
    });

    it("falls back to English for an unknown locale", () => {
      const copy = phiFreeNotificationCopy(URL, "de" as never);
      expect(copy.emailSubject).toBe(phiFreeNotificationCopy(URL, "en").emailSubject);
    });
  });
});
