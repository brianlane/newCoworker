# White-Glove Build & Installation Template

This is the blank reference copy of the white-glove build template, distilled from the
Lead Management PRD (`PRDs/Lead Management.pdf`) into a short, plain-English,
industry-agnostic document.

**Normal flow:** admins don't fill this out by hand — they create the intake
questionnaire from the admin panel (All Clients → "White-glove setup questionnaires"),
supplying the business name and industry themselves (email optional — with one the link
is emailed automatically, without one they get a shareable link). The prospect answers
on the public `/intake/<token>` page and the completed build document (this template,
filled in) is generated at `/admin/intake-doc/<id>`, ready to print, save as PDF, or
send. Keep this file for reference and for the rare offline/manual deal.

**De-duplication rule:** the questionnaire never re-asks anything the onboarding
interview already collects (business name, industry, owner, phone, website, service
area, team size, CRM, tone). Section 1 below is filled by the admin, not the prospect.

---

## 1. About the business

- Business (filled by our team): ______________________________________
- Industry (filled by our team): ______________________________________
- Business hours: ______________________________________

## 2. Team & handoffs

Leads are handed to (in order — name and mobile number per line):

- ______________________________________
- ______________________________________
- ______________________________________

## 3. Lead sources

- [ ] Facebook / Instagram ads
- [ ] Website form
- [ ] Google ads / search
- [ ] Phone calls
- [ ] Referrals
- [ ] Other: ______________________________________

## 4. The first message

- Greeting (sent within 60 seconds of a new lead):

  > ______________________________________

- The assistant may ask AT MOST these questions before booking (3 max — fewer
  questions means fewer leads lost):

  1. ______________________________________
  2. ______________________________________
  3. ______________________________________

- If the lead asks to talk to someone, the assistant stops asking and books
  immediately.

## 5. Appointments

- Appointment length: ☐ 15 min ☐ 30 min ☐ 45 min ☐ 1 hour
- Buffer between appointments: ☐ None ☐ 15 min ☐ 30 min
- Earliest booking: ☐ Same day, short notice OK ☐ At least 2 hours ahead ☐ Next business day
- Booking window: ☐ 1 week ☐ 2 weeks ☐ 30 days ☐ 60 days

## 6. Follow-up schedule (no lead is ever forgotten)

- First nudge if a lead doesn't reply: ☐ 2 hours ☐ 4 hours ☐ same day ☐ next morning
- Second nudge: ☐ next day ☐ 2 days ☐ 3 days ☐ 1 week
- Flag for a personal touch: ☐ after 2 ☐ after 3 ☐ after 5 unanswered follow-ups
- Quiet leads are marked inactive, never deleted — if they reply weeks later, the
  conversation resumes where it left off.

## 7. When a human takes over

The assistant immediately hands off (never improvises) on:

- [ ] Quoting prices or discounts
- [ ] Professional / licensed advice
- [ ] Complaints or disputes
- [ ] Cancellations or refunds
- [ ] Legal or medical questions
- [ ] Taking payments
- [ ] Other: ______________________________________
- Any time the lead asks for a person
- Any time the lead sounds frustrated

## 8. Compliance

- Lead-form text/call consent wording (TCPA): ☐ In place ☐ Needs help adding it
- STOP / HELP replies are always honored automatically.

## 9. Notes

______________________________________

## 10. Installation checklist (completed by our team)

- [ ] Account created and server provisioned
- [ ] Business phone number assigned and tested
- [ ] Assistant personality configured from this document
- [ ] Team calendar(s) connected
- [ ] Lead sources connected and a test lead sent end-to-end
- [ ] First-message wording approved by the customer
- [ ] Follow-up schedule configured as above
- [ ] Go-live

## 11. Go-live acceptance (both sides confirm)

- [ ] A test lead received a text within 60 seconds
- [ ] Every lead shows a clear status at all times
- [ ] Follow-up nudges fire on the agreed schedule
- [ ] Handoff topics reach a person immediately
- [ ] Opt-out (STOP) is honored

Customer signature: ______________________ Date: __________

Installer signature: ______________________ Date: __________
