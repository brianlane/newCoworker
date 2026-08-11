# Tristar Physical Therapy: outreach draft

**Status: DRAFT, not sent.** Brian sends it, or tells me to.

## Who they are

| | |
| --- | --- |
| Business | Tristar Physical Therapy and Chiropractic |
| Contact | Dr. Jordan Black, PT, DPT, owner and founder |
| Email | jblack@tristarpt.com |
| Locations | 8: Maryville, Bean Station, Newport, Jefferson City, Morristown, Rogersville, New Tazewell, Johnson City |
| Region | East Tennessee |
| Services | Physical therapy, occupational therapy, pediatric, pelvic floor, dry needling, sports rehab, vestibular, cupping, ultrasound, workers' comp |
| Social proof | "Over 1450 5 Star Reviews" on the homepage, 5-star Google and Facebook |
| Scheduling | info@tristarpt.com, (423) 317-7772 |
| Billing | billing@tristarpt.com, (423) 375-8907 |
| Main line | (423) 641-0650 |

**How we know him:** on Aug 5 2026 at 19:30 UTC (3:30pm Eastern) he signed in to
newcoworker.com with Google, landed on an empty dashboard because of the bug
fixed in PR #1273, accepted the Terms four seconds later, and never came back.
He was evaluating us and the product broke in his face.

## Their stack, read off their own site

- **Prompt EMR** (`scheduling.go.promptemr.com`) for online scheduling, the
  patient portal, and payments. Every "Schedule an appointment" CTA lands on
  `patientLogin?returnTo=/onlineScheduling`, so a prospective patient has to
  create a portal account before they can ask anything.
- **JotForm (HIPAA plan)** for physician referrals and new patient forms.
- **CardPointe** for bill pay, **CareerPlug** for hiring, a GoHighLevel-style
  booking widget at `link.tristarpt.com`, and a `shop.tristarpt.com` storefront.

## Why they are a fit

1. **Eight clinics, one front desk.** Every location on the contact page lists
   the same scheduling address and, on inspection, several of the displayed
   location numbers dial through to the same line, (423) 641-0650. One team is
   absorbing eight buildings' inbound.
2. **The portal is a wall for top-of-funnel questions.** "Do you take my
   insurance", "do I need a referral", "which location is closest", "what do I
   wear" all require a phone call, because the only self-serve path demands a
   patient login first.
3. **Referrals arrive as forms.** A JotForm submission sits until someone opens
   it. Speed to first contact is the whole game on a physician referral.
4. **They are growing and hiring.** A ribbon-cutting on the Morris Boulevard
   location and an active CareerPlug board mean front-desk load is going up,
   not down.

## The honest blocker: no BAA

We do not offer HIPAA compliance or a signed BAA. Every HIPAA line in our own
comparison copy sits on the competitor side of the table (Zinng offers it, so
do the established answering services). A healthcare owner will ask about this
in his first reply, so the email names it before he has to.

That is not fatal, because the pitch is scoped to pre-PHI, top-of-funnel work:
general questions, new patient interest, routing to the right clinic, handoff
to Prompt for the actual booking, after-hours coverage. If he wants the AI
coworker touching clinical detail or existing patient records, we cannot serve
that today and should say so.

**What a HIPAA lane would cost, since he will ask.** Costed out in the plan at
`~/.claude/plans/zippy-bouncing-phoenix.md`: roughly **$1,384/month in fixed,
org-level vendor spend** (Supabase Pro to Team at +$574, their HIPAA add-on,
Point in Time Recovery at +$100, and a Vercel HIPAA add-on), paid whether we
have one healthcare tenant or fifty. Against a typical Standard margin of about
$130, that is roughly 11 tenants' entire margin before it earns a dollar, and a
single anchor deal has to clear about **$1,600 to $2,100/month** to carry it.

Two consequences for this pitch: HIPAA is **enterprise-only pricing**, so the
published $99 Standard number must not appear in the email; and we should not
spend that money until a deal is committed. Hence the contingent framing below.

## Recommended email

> **Subject:** You hit a bug on our site last week, and it is fixed
>
> Dr. Black,
>
> On August 5 you signed in to newcoworker.com with Google and landed on an
> empty dashboard. That was our bug, not your mistake: our sign-in quietly
> created an account with nothing behind it instead of telling you that you
> did not have one yet. We caught it in the middle of shipping a feature
> request and fixed it in the same stretch of work, so it is live now. You
> were curious enough to click, so I would rather show you the product
> properly than let a broken first impression be the whole story.
>
> While I was in there I read through your site. Eight clinics from Maryville
> to Johnson City, all pointing at one scheduling address and, when you follow
> the links, largely one phone line. That desk is also catching physician
> referrals through your JotForm app, applicants from CareerPlug, and every
> patient who did not want to create a Prompt portal login just to ask whether
> you take their insurance.
>
> New Coworker answers that layer. It picks up the calls and emails your team
> cannot get to, answers the repeat questions in your own words, works out
> which of the eight locations the person needs, captures the new patient, and
> hands the booking to your existing scheduling. Nights and weekends included,
> which is when someone in pain goes looking for a physical therapist.
>
> Two things I want to be straight about before you spend time on this.
>
> First, we are not HIPAA compliant today and we do not sign a BAA. So the
> version I would put in front of you now is scoped to the front of your
> funnel: general questions and new patient capture, deliberately kept away
> from clinical detail and existing records.
>
> Second, I have costed out what a HIPAA lane actually takes, and it is real
> money in vendor agreements rather than a switch we flip. I am willing to
> build it, but honestly only against a committed multi-clinic deal, and that
> is an enterprise conversation rather than our published pricing.
>
> So: worth twenty minutes? I will show you the thing answering a
> Tristar-shaped call, and you can tell me which of those two versions is
> actually useful to you.
>
> Brian Lane
> New Coworker

## If the bug reference feels too close

Some owners find "we noticed you visited" off-putting. Swap the first
paragraph for a cold opener and lose nothing else:

> Dr. Black,
>
> You run eight physical therapy clinics across East Tennessee and, as far as
> your contact page shows, one scheduling inbox and largely one phone line
> behind all of them. I build something for exactly that gap.

The bug version is stronger. It is true, it is specific, it explains why he is
hearing from us, and it opens with us taking the blame for something. That
tends to land better with an owner than a cold observation about his staffing.

## Signup path: clear

His orphan auth row (`e04812d8-e279-4f4c-8195-5e4e675c8283`, google-only,
created Aug 5 2026) was deleted on Aug 10 2026. While it existed it deadlocked
him: `/api/onboard/check-email` and `/api/checkout` both read his address as
already taken, while the new sign-in gate refused his Google login because he
owned nothing.

Verified against production after the delete:

```
POST /api/onboard/check-email {"email":"jblack@tristarpt.com"}
=> {"ok":true,"data":{"available":true}}
```

So he can now run the normal questionnaire, checkout, and set-password flow
with this address. His clickwrap row in `terms_acceptances` was retained on
purpose: that table is insert-only evidence with no foreign key to
`auth.users`, and `service_role` holds no delete grant on it.
