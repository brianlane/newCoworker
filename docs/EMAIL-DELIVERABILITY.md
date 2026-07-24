# Email deliverability and sender branding (newcoworker.com)

Runbook for the platform email domain's authentication posture, the DMARC
ramp, and the path to showing the New Coworker logo next to our emails in
recipients' inboxes. Ops surfaces referenced here (Cloudflare DNS, Resend,
the platform Gmail account) are external to this repo; this doc is the
single place that records their intended state.

## How mail flows today

- **Inbound**: MX for `newcoworker.com` points at Cloudflare Email Routing.
  Two real routing rules (`team@`, `contact@`) forward to the platform Gmail
  inbox (`newcoworkerteam@gmail.com`); the catch-all feeds the Email Worker
  (`cloudflare/email-worker/`) which posts to `/api/email/inbound` and
  resolves tenant AI mailboxes via `src/lib/email/tenant-mailbox.ts`.
- **Outbound (platform + tenants)**: Resend, DKIM-signed as
  `newcoworker.com` (`resend._domainkey`), Return-Path on
  `send.newcoworker.com`. This traffic is DMARC-aligned.
- **Outbound (human replies from team@/contact@)**: Gmail "Send mail as"
  from the platform Gmail account. Until the send-as entries are switched to
  Resend SMTP (below), these sends are signed as `gmail.com` and are NOT
  DMARC-aligned.

## DMARC state and ramp plan

`_dmarc.newcoworker.com` was published 2026-07-24 (Cloudflare, TTL 1h):

```text
v=DMARC1; p=none; rua=mailto:team@newcoworker.com
```

`p=none` is monitoring only: nothing is quarantined, and aggregate reports
arrive at team@ (forwarded to the platform Gmail). Ramp procedure:

1. **Prerequisite, do first**: switch the Gmail "Send mail as" entries for
   `team@` and `contact@` to Resend SMTP so human replies are DKIM-aligned:
   server `smtp.resend.com`, port `465` (SSL), username `resend`, password =
   a dedicated Resend API key (create a separate key named for this use;
   never reuse the production `RESEND_API_KEY`). Verify by emailing an
   outside Gmail account and checking Show original: SPF/DKIM/DMARC all
   `PASS` with DKIM domain `newcoworker.com`.
2. Watch the aggregate reports for 2-4 weeks. Every legitimate source
   (Resend transactional, blog subscriber email, tenant AI mailboxes, the
   Gmail-via-Resend replies) must show as aligned before ramping.
3. Move to `p=quarantine`, then after another clean cycle `p=reject`.
   Never ramp while step 1 is incomplete: an enforcing policy sends our own
   Gmail-relayed replies to spam.

DMARC at `p=quarantine`/`p=reject` (pct=100) is also the hard prerequisite
for BIMI below, and Google's bulk-sender rules expect at least `p=none`.

## Logo in Gmail

Two mechanisms, independent of each other:

- **Google profile photo (live path, free, Gmail recipients only)**:
  `team@newcoworker.com` has a Google account created with the existing
  address (accounts.google.com, "Use my current email address instead"; the
  verification mail arrives through the Cloudflare forward). Its profile
  photo is the logo (`public/logo-512.png`, solid background). Gmail
  resolves sender avatars by From address, so recipients see the logo on
  mail from team@. The platform Gmail account carries the same photo.
  Propagation after changing the photo can take a day or two.
- **BIMI (all major inboxes, paid, not yet attainable)**: requires DMARC at
  enforcement plus an SVG Tiny PS logo plus a mark certificate. As of
  Jul 2026 New Coworker has no registered trademark (rules out a VMC,
  ~$1,200+/yr, which is also what unlocks Gmail's blue checkmark) and the
  logo has been publicly used for under 12 months (rules out a CMC,
  ~$650-1,100/yr, logo only). Wayback Machine snapshots of the homepage and
  blog were requested 2026-07-24 to start the CMC evidence clock; CAs verify
  the 12-month public-use requirement against web archives. Revisit around
  **mid-2027** for a CMC, or sooner if a trademark registration lands.
  When eligible: host the SVG logo and the CA-issued PEM over HTTPS, then
  publish `default._bimi.newcoworker.com TXT
  "v=BIMI1; l=<svg-url>; a=<pem-url>"`.

## Verification commands

```bash
dig +short TXT _dmarc.newcoworker.com        # DMARC policy
dig +short TXT newcoworker.com               # SPF (Cloudflare Email Routing)
dig +short TXT resend._domainkey.newcoworker.com   # Resend DKIM key
dig +short TXT default._bimi.newcoworker.com # BIMI (empty until eligible)
```

For a live send, use Gmail's "Show original" on the received message: it
prints SPF, DKIM (with the signing domain), and DMARC verdicts.
