# Incident Response Policy

**Owner:** Brian Lane, Newcoworker LLC
**Effective:** July 31, 2026
**Review cadence:** annually, or after any Severity 1 incident

Written for the ADA-CASA AL1 assessment of GCP project `new-coworker`
(project number 354099628168). It describes how incidents are actually
handled on this system, not a generic program. Where a control is a person
rather than a rota, it says so: New Coworker is operated by a single
engineer, and a policy that implied a staffed 24/7 SOC would be a policy that
fails its first audit.

## 1. Scope

The production web application at `https://www.newcoworker.com`, its Supabase
project (Postgres, Auth, Storage, Edge Functions), the per-tenant VPS fleet,
the Cloudflare zone, and the third-party integrations that hold customer data
on our behalf (Nango for Google and Microsoft OAuth tokens, Stripe for
payments, Telnyx for voice and SMS).

## 2. Severity levels

| Level | Definition | Examples |
| --- | --- | --- |
| **S1** | Confirmed unauthorized access to customer data, or credential compromise | Leaked service role key, tenant data readable across a tenant boundary |
| **S2** | Exploitable vulnerability with no evidence of exploitation | Authentication bypass found by a researcher or scanner |
| **S3** | Security-relevant defect with limited impact | Missing authorization check on a low-value endpoint |
| **S4** | Hardening gap, no direct exploitability | Absent security header, verbose error message |

## 3. Detection

Incidents reach us through:

- **Researcher reports** to `team@newcoworker.com`, published at
  `/.well-known/security.txt` and `/security/vulnerability-disclosure`.
- **CI security gates**: CodeQL on every push and weekly
  (`.github/workflows/codeql.yml`), and `npm audit` across the root and every
  deployable subproject (`.github/workflows/audit.yml`), which blocks on
  high-severity findings.
- **Deploy failure alerts**: a failed push-to-main run is re-run once
  automatically and a second consecutive failure emails
  `team@newcoworker.com` (`.github/workflows/main-failure-watch.yml`).
- **Provider notifications** from Supabase, Vercel, Cloudflare, Stripe and
  Telnyx.
- **Daily posture pass**, which reports untracked VMs and tenants without a
  box.

## 4. Response

1. **Triage and assign severity** within one business day of becoming aware.
   S1 preempts all other work.
2. **Contain.** The specific levers available, in rough order of reach:
   rotate the affected secret; revoke Supabase sessions for affected users;
   disable the affected AiFlow or tenant; block at the Cloudflare edge; take
   the affected VPS out of the fleet. Containment precedes root cause.
3. **Preserve evidence** before destructive remediation: capture the relevant
   Vercel and Supabase logs, and the Cloudflare event sample, since these have
   finite retention.
4. **Eradicate and recover** through the normal change path: branch, pull
   request, CI and automated review green, squash merge, then confirm the
   push-to-main deploy is green. Production has not changed until that run is
   green. Emergency changes use the same path; the pull request is not
   skipped, it is expedited.
5. **Verify** the fix against production, not only against tests. Anything
   observable only from outside is checked from outside.

## 5. Notification

For any incident confirmed as unauthorized access to customer personal data,
affected business owners are notified by email without undue delay and within
72 hours of confirmation, with what happened, what data was involved, what we
have done, and what they should do. Where a customer is a data controller and
we are their processor, they are notified so they can meet their own
obligations. Regulatory notification is assessed case by case against the
applicable regime.

Google is separately notified for any incident affecting Google user data
obtained through the OAuth scopes granted to project `new-coworker`, per the
Google API Services User Data Policy.

## 6. Post-incident review

Every S1 and S2 gets a written review covering the timeline, root cause,
what detection missed, and the change that prevents recurrence. The bias of
this codebase is to convert a lesson into a test or a CI guard rather than a
note, so the review is not complete until that guard exists or has been
explicitly declined with a reason.

## 7. Known limitations

Stated deliberately, because an assessor will find them anyway and an honest
list is worth more than a flattering one:

- Response is one engineer. There is no on-call rotation and no 24/7 coverage.
- Log retention is whatever Vercel, Supabase and Cloudflare provide on the
  current plans; there is no independent long-term SIEM.
- Alerting on anomalous application behaviour is limited to deploy failure and
  the daily posture pass. There is no behavioural intrusion detection.
