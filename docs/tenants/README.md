# Tenant dossiers

One file per tenant we operate by hand. Read the dossier before touching a
tenant's flows, seeds, or data.

## Why these exist

"Review everything about Amy / KYP / Truly" was asked more than ten times in
two weeks, and each time it meant re-deriving the same picture from scratch:
scan the chat archive, scan the PR list, query the flows, work out which
one-shots had been applied and why. Same cognition, same answer, re-bought
every session. The answer lives here now, and a session that starts by
reading one file gets to the actual question immediately.

This is the same rule the rest of the repo already follows: once a behavior is
understood and repeatable, capture it deterministically. `debug/` did it for
ops procedures, `scripts/oneshot/` for one-time fixes, the CI guards for
solved bugs. Dossiers do it for tenant knowledge.

## Dossiers

| Tenant | File | Shape of the account |
| --- | --- | --- |
| Amy Laidlaw Real Estate | [amy-laidlaw-real-estate.md](amy-laidlaw-real-estate.md) | Heaviest AiFlow user. Referral-network leads (Clever, HomeLight, ReferralExchange, Realtor.com), 4-person roster |
| KYP Ads | [kyp-ads.md](kyp-ads.md) | White-glove build, Calendly-centric, Canadian DID, has an incident review |
| Truly Insurance | [truly-insurance.md](truly-insurance.md) | Commercial insurance, Privyr email leads, renewals. Lapsing (cancel-at-period-end Aug 8, not paused), boxless, DID reserved |
| Scar Fairy | [scar-fairy.md](scar-fairy.md) | Standard signup; Jul 29 cutover from mispriced KVM 8 onto Truly's former KVM 2 (`1815606`), then swept onto `1867409` a day later by the term-renewal bug |
| KIN Integrated Child Health | [kin-integrated-child-health.md](kin-integrated-child-health.md) | White-glove build via James referral, Zapier Meta leads, JaneApp link handoff, Alberta DID swap. Lead follow-up flow LIVE since 2026-08-26 (on by design) |
| New Coworker (HQ) | [new-coworker-hq.md](new-coworker-hq.md) | Our own dogfood tenant. Also the homepage demo line, the site webchat, and every smoke test's default target |
| HomeLight referral flow | [homelight-flow.md](homelight-flow.md) | Not a tenant: a lead source inside Amy's account, complex enough to own a file |

Not dossiered yet (small, low-touch): the Zoom / Meta / Google reviewer
sandboxes. Add a file when one of them takes real operating effort.

## Keeping them true

**A PR that changes a tenant's flows, seeds, or one-shots must update that
tenant's dossier in the same PR.** Same contract as the KG source registry and
the coworker-tool parity list: the doc is only worth reading if it cannot
silently fall behind. A dossier that lies is worse than no dossier, because it
gets trusted.

Live values (flow enable state, roster, DIDs, applied one-shots) are best read
fresh rather than from prose:

```bash
npx tsx scripts/context-pack.ts        # fleet snapshot: ids, tiers, DIDs, flow counts
tsx debug/audit-account.ts --business <uuid>   # one tenant's live posture and recent activity
```

The dossier carries what those commands cannot: why the account is shaped the
way it is, which decisions are deliberate, and which sharp edges have already
cut us.

## Writing a new one

Follow the existing files. The sections that earn their place:

- **Identity** (ids, DID, box, tier, owner, roster) so no lookup is needed to
  run a script.
- **How leads arrive**, because that drives everything else.
- **Flows**, with the quirk that makes each one non-obvious.
- **Sharp edges**, the mistakes already made on this account.
- **History**, linking PRs and one-shots rather than restating them.

Keep end-user (lead/customer) identifiers out. Business DIDs and staff first
names are fine; a lead's phone number is not (see the PII rule in
[debug/README.md](../../debug/README.md)).
