/**
 * Prospecting, the site probe: what can we honestly say about this business
 * before we email them?
 *
 * The pitch is only allowed to claim what a finding recorded, so every finding
 * carries the evidence that produced it (a marker that was missing, or the
 * text that matched). No adjectives, no inference: "your site has no booking
 * link" is checkable, "your website is bad" is not.
 *
 * Deliberately cheap and forgiving. Two GETs at most (the homepage, then a
 * contact page if the homepage carried no address), a hard body cap, a short
 * timeout, and every failure degrades to "we could not read the site" rather
 * than throwing, because an unreachable prospect should be skipped, not fatal
 * to the pass.
 */

import { siteUrl } from "@/lib/marketing/site-url";
import type { PlacesOpeningHours } from "./discover";

/** A checkable observation about a prospect's site. */
export type ProbeFinding = { code: string; detail: string };

export type ProbeResult = {
  findings: ProbeFinding[];
  /** Best contact address found, or null when the site published none. */
  email: string | null;
  /** False when the site could not be read at all (findings will be empty). */
  reachable: boolean;
  /** Why the read failed, for the ledger's status_detail. */
  failure?: string;
};

/** Body bytes read per page, hooks live in the markup, not in megabytes. */
export const PROBE_MAX_BYTES = 400_000;

/** Per-request timeout. A slow prospect is skipped, not waited on. */
export const PROBE_TIMEOUT_MS = 8_000;

/**
 * Markers that prove a capability exists. Absence is what we report, so these
 * lists are deliberately generous: a false "you have no booking link" is a
 * credibility loss on first contact, while missing a hook costs nothing.
 */
const BOOKING_MARKERS = [
  "calendly.com",
  "acuityscheduling",
  "squareup.com/appointments",
  "booksy.com",
  "schedulicity",
  "vagaro.com",
  "setmore.com",
  "simplybook",
  "mindbodyonline",
  "housecallpro",
  "servicetitan",
  "jobber",
  "book now",
  "book online",
  "book an appointment",
  "schedule online",
  "schedule an appointment",
  "request an appointment",
  "request appointment"
];

const CHAT_MARKERS = [
  "intercom",
  "drift.com",
  "tawk.to",
  "tidio",
  "crisp.chat",
  "js.hs-scripts.com",
  "zdassets",
  "livechatinc",
  "podium.com",
  "olark",
  "zohopublic",
  "chatwoot",
  "live chat",
  "chat with us"
];

const SMS_MARKERS = ["sms:", "text us", "text me", "send us a text", "message us"];

const PHONE_MARKERS = ["tel:"];

/** Addresses that are never a real contact address for the business. */
const EMAIL_NOISE = [
  "example.com",
  "example.org",
  "sentry.io",
  // Any self-hosted Sentry, not just sentry.io: a Sentry DSN
  // (`https://<32-hex-key>@sentry.<host>/<project>`) in page JavaScript reads
  // as an email to the regex below. A live pitch went to
  // `<key>@sentry.wixpress.com` (Wix's Sentry) on 2026-08-27 and bounced.
  "@sentry.",
  "wordpress.com",
  "wordpress.org",
  "wix.com",
  // Wix's internal domain, where its platform services (Sentry included)
  // live. Never a customer mailbox.
  "wixpress.com",
  "squarespace.com",
  "godaddy.com",
  "domain.com",
  "email.com",
  "yourdomain",
  "sentry-next",
  "no-reply",
  "noreply",
  "donotreply"
];

/**
 * A localpart of 20+ hex characters is a credential or tracking key swept up
 * by the address regex, not a mailbox a person reads. Sentry DSN public keys
 * are 32 hex chars; no real business publishes a contact address like that,
 * and pitching one burns a prospect on a machine that bounces.
 */
const MACHINE_KEY_MAILBOX_RE = /^[0-9a-f]{20,}@/;

/** Mailbox names that read as a published contact address rather than a person. */
const PREFERRED_MAILBOXES = ["info", "contact", "hello", "office", "sales", "admin", "support"];

/** Weekend-closed evidence, e.g. "Closed Sunday" or "closed on weekends". */
const WEEKEND_CLOSED_RE = /closed\s+(?:on\s+)?(?:sat(?:urday)?|sun(?:day)?|weekends?)/i;

/**
 * Posted weekday hours with an afternoon close, e.g. "Mon - Fri 8:00 am - 5:00
 * pm". The em dash and en dash are matched by escape, never typed literally
 * (repo writing rule).
 */
const WEEKDAY_HOURS_RE =
  /(?:mon|tues?|wed|thur?s?|fri)[a-z.]*\s*(?:[-\u2013\u2014]|to)\s*(?:fri|sat)[a-z.]*[^a-z0-9]{0,16}(\d{1,2})(?::\d{2})?\s*(?:a\.?m\.?)?\s*(?:[-\u2013\u2014]|to)\s*(\d{1,2})(?::\d{2})?\s*p\.?m\.?/i;

/** An afternoon close at or before this hour leaves an after-hours gap. */
const AFTER_HOURS_CLOSE_AT_OR_BEFORE = 6;

function hasAnyMarker(haystack: string, markers: string[]): boolean {
  return markers.some((m) => haystack.includes(m));
}

/**
 * The conversation hooks this page supports. `html` is expected lowercased by
 * the caller (probeSite does it once for both pages).
 */
export function detectFindings(html: string): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  if (!hasAnyMarker(html, BOOKING_MARKERS)) {
    findings.push({
      code: "no_online_booking",
      detail: "No booking link or scheduler found on the site, so appointments have to be arranged by phone or email."
    });
  }
  if (!hasAnyMarker(html, CHAT_MARKERS)) {
    findings.push({
      code: "no_chat_widget",
      detail: "No chat widget on the site, so a visitor with a question has to call or fill in a form."
    });
  }
  if (!hasAnyMarker(html, SMS_MARKERS)) {
    findings.push({
      code: "no_text_option",
      detail: "No way to text the business from the site."
    });
  }
  if (!hasAnyMarker(html, PHONE_MARKERS)) {
    findings.push({
      code: "no_tap_to_call",
      detail: "No tap-to-call phone link, so a phone visitor has to copy the number by hand."
    });
  }
  const weekend = WEEKEND_CLOSED_RE.exec(html);
  if (weekend) {
    findings.push({
      code: "closed_weekends",
      detail: `The site states "${weekend[0].trim()}", so weekend enquiries wait until Monday.`
    });
  }
  const hours = WEEKDAY_HOURS_RE.exec(html);
  if (hours) {
    const closeHour = Number(hours[2]);
    if (closeHour <= AFTER_HOURS_CLOSE_AT_OR_BEFORE) {
      findings.push({
        code: "after_hours_gap",
        detail: `Posted hours "${hours[0].trim()}" mean calls after closing go unanswered.`
      });
    }
  }
  return findings;
}

/**
 * Contact addresses published on the page, best first: a mailbox at the
 * prospect's own domain beats a third-party one, and a published role mailbox
 * (info@, contact@) beats a personal one. Noise (platform boilerplate,
 * no-reply senders, image filenames that happen to contain an @) is dropped.
 */
export function extractEmails(html: string, domain: string): string[] {
  // Every quantifier here is BOUNDED, and that is load-bearing rather than
  // tidy. With an unbounded local part, a long run of word characters (a
  // minified script with no @ in it, which is most of them) makes the engine
  // match the whole run, fail to find an @, and backtrack a character at a
  // time from every starting position: quadratic, and it hung the probe on a
  // 400KB page. The bounds are the real RFC limits, so nothing valid is lost.
  const matches = html.match(/[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,24}/gi) ?? [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of matches) {
    const email = raw.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    if (EMAIL_NOISE.some((n) => email.includes(n))) continue;
    // A filename that swept up an @ is not an address.
    if (/\.(?:png|jpe?g|gif|svg|webp|css|js)$/.test(email)) continue;
    if (MACHINE_KEY_MAILBOX_RE.test(email)) continue;
    candidates.push(email);
  }
  const score = (email: string): number => {
    const [mailbox, host] = email.split("@");
    const ownDomain = host === domain || host.endsWith(`.${domain}`);
    const role = PREFERRED_MAILBOXES.includes(mailbox);
    return (ownDomain ? 2 : 0) + (role ? 1 : 0);
  };
  return candidates.sort((a, b) => score(b) - score(a));
}

/** Codes whose evidence Google can supply better than the prospect's HTML can. */
const HOURS_CODES = ["closed_weekends", "after_hours_gap"];

/** Weekday indexes in Google's opening-hours periods (0 = Sunday). */
const SATURDAY = 6;
const SUNDAY = 0;

/**
 * Latest weekday close, on Google's 24-hour clock, that still leaves an
 * after-hours gap worth mentioning. Separate from the HTML regex's constant
 * because that one reads a 12-hour clock off the page.
 */
const AFTER_HOURS_LATEST_CLOSE_HOUR_24 = 18;

/**
 * The hours findings, from Google's structured opening hours instead of a
 * regex over the prospect's markup.
 *
 * This is the same claim as the HTML version and a far better source. Google
 * holds hours for most operating businesses, in fields, whereas the site check
 * finds nothing at all on any page that renders its hours in JavaScript, which
 * is most modern sites. Returns null when Google has no hours, which is the
 * signal to fall back to the markup.
 *
 * The detail lines are phrased from the numbers rather than quoting Google's
 * own `weekdayDescriptions`: those carry a dash character we are not allowed to
 * emit, and a sentence reads better in a cold email than a pasted schedule.
 */
export function hoursFindings(hours: PlacesOpeningHours | null): ProbeFinding[] | null {
  const periods = hours?.periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;

  /**
   * Two shapes make every hours claim unsafe, and both look innocuous in the
   * data:
   *
   * A period with NO `close` is open-ended. Google reports "always open" this
   * way, and reading the remaining periods as a weekly schedule then invents a
   * weekend closure for a business that never shuts.
   *
   * A `close` on a LATER day than its `open` runs past midnight: Friday 6 PM to
   * Saturday 2 AM arrives as close.hour 2, which reads as "closes by 2 AM" and
   * would tell a bar that stays open until 2 in the morning that it closes too
   * early. It also means they ARE open on the next day, so the weekend claim is
   * wrong too.
   *
   * Either shape returns an empty list rather than null: Google DID have hours,
   * so the markup regex should not get a second guess at the same question. The
   * prospect can still be pitched on what their site is missing. Saying nothing
   * about hours costs a sentence; saying something false costs the reply.
   */
  const unsafeToRead = periods.some((p) => {
    if (!p.close || typeof p.close.hour !== "number") return true;
    return (
      typeof p.close.day === "number" &&
      typeof p.open?.day === "number" &&
      p.close.day !== p.open.day
    );
  });
  if (unsafeToRead) return [];

  const findings: ProbeFinding[] = [];
  const openDays = new Set(
    periods.map((p) => p.open?.day).filter((d): d is number => typeof d === "number")
  );
  if (openDays.size > 0 && !openDays.has(SATURDAY) && !openDays.has(SUNDAY)) {
    findings.push({
      code: "closed_weekends",
      detail: "Google lists the business as closed on Saturday and Sunday, so weekend enquiries wait until Monday."
    });
  }

  const weekdayCloses = periods
    .filter((p) => {
      const day = p.open?.day;
      return typeof day === "number" && day !== SATURDAY && day !== SUNDAY;
    })
    .map((p) => p.close?.hour)
    .filter((h): h is number => typeof h === "number");
  if (weekdayCloses.length > 0) {
    const latest = Math.max(...weekdayCloses);
    if (latest <= AFTER_HOURS_LATEST_CLOSE_HOUR_24) {
      findings.push({
        code: "after_hours_gap",
        detail: `Google lists the business as closing by ${formatHour(latest)} on weekdays, so calls after that go unanswered.`
      });
    }
  }
  return findings;
}

/** 17 to "5 PM", for a sentence rather than a schedule. */
function formatHour(hour24: number): string {
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour} ${suffix}`;
}

/**
 * Google's hours findings replace the site's, when Google has hours at all.
 *
 * Only the hours codes are substituted: the booking link, chat widget, text
 * option and tap-to-call findings are properties of the SITE, and Google has
 * nothing to say about them.
 */
export function mergeHoursFindings(
  siteFindings: ProbeFinding[],
  googleFindings: ProbeFinding[] | null
): ProbeFinding[] {
  if (googleFindings === null) return siteFindings;
  return [...siteFindings.filter((f) => !HOURS_CODES.includes(f.code)), ...googleFindings];
}

export type ProbeDeps = {
  fetchImpl?: typeof fetch;
};

/** GET a page, capped and timed out. Returns null when it cannot be read. */
async function readPage(url: string, deps: ProbeDeps): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Identify ourselves honestly: a site owner reading their logs should
        // be able to tell who looked and why.
        "User-Agent": `NewCoworkerProspectBot/1.0 (+${siteUrl("/about")})`,
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if (!res.ok) return null;
    const body = await res.text();
    return body.slice(0, PROBE_MAX_BYTES).toLowerCase();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one prospect. The homepage supplies the findings; when it publishes no
 * address we try one conventional contact path, because an unreachable
 * prospect is a wasted discovery rather than a send.
 */
export async function probeSite(
  website: string,
  domain: string,
  deps: ProbeDeps = {}
): Promise<ProbeResult> {
  const home = await readPage(website, deps);
  if (home === null) {
    return { findings: [], email: null, reachable: false, failure: "site unreadable" };
  }
  const findings = detectFindings(home);
  let emails = extractEmails(home, domain);
  if (emails.length === 0) {
    const contactUrl = new URL("/contact", website).toString();
    const contact = await readPage(contactUrl, deps);
    if (contact !== null) emails = extractEmails(contact, domain);
  }
  return { findings, email: emails[0] ?? null, reachable: true };
}
