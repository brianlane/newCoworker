import { contactEmail } from "@/lib/marketing/contact-email";
import { siteUrl } from "@/lib/marketing/site-url";

/**
 * RFC 9116 security.txt: the machine-readable "where do I report a
 * vulnerability" pointer.
 *
 * Added during the ADA-CASA AL1 assessment, which asks for an evidenced
 * vulnerability disclosure channel. `/.well-known/security.txt` returned 404
 * before this, so a researcher who found something had to guess an address.
 *
 * `Expires` is required by the RFC and must be a future date, so it is
 * computed rather than hardcoded: a stale expiry is worse than no file,
 * because scanners read it as an abandoned policy. One year out, recomputed
 * per request.
 *
 * Origins come from `siteUrl` and the contact address from `contactEmail`,
 * rather than literals, per the single-home rule for deployment constants in
 * `src/lib/marketing/site-url.ts`.
 */

export const dynamic = "force-dynamic";

/** RFC 9116 recommends an expiry no more than about a year out. */
const EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

export function GET(): Response {
  const expires = new Date(Date.now() + EXPIRY_MS).toISOString();
  // Same accessor as the sibling legal pages (privacy, terms, and the
  // disclosure policy this file points at), which is the point: the policy
  // page tells readers the two addresses are the same, so they have to
  // resolve from one place.
  const body = [
    `Contact: mailto:${contactEmail()}`,
    `Policy: ${siteUrl("/security/vulnerability-disclosure")}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en, es",
    `Canonical: ${siteUrl("/.well-known/security.txt")}`,
    ""
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600"
    }
  });
}
