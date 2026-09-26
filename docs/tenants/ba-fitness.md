# BA Fitness LLC (Brett Allen)

Business id: `d2d421a8-47ef-4a1d-b8af-7e86a02a95f1`. Standard, monthly.
Signed up 2026-09-18. Timezone America/New_York. Data residency `supabase`
(central reads are the right ones). Owner login `info@bafitness.net`.
DID `+14808061313` (Quinn). Campaign registered. The business row's forward
number is the coaching line. The owner also has a personal cell, which is
not the coworker number and must not be offered as the test line.

Referred by James (KYP Ads), who runs the Meta ads. Same Zapier shape as
KIN and KYP: one API key, action "Send Lead to Coworker". The key was minted
by `mint-kin-zapier-key.ts` (the script takes any business id; the row name
is "Zapier (Meta leads via KYP)"). James reads email and the dashboard. Do
not SMS him.

## How leads arrive

Two paths, and they must stay apart.

1. **Meta lead ads.** James's Zap posts to `POST /api/public/v1/flow-events`
   with source `facebook_lead_ads`. Forms seen on 2026-09-23 include clinic
   partnership forms ("GLP1 Clinics - Qualified v4") and a patient form
   ("KYP - GLP1 Patients - Manual"). A Zapier post does not create a contact
   by itself. It only starts an enabled webhook flow.
2. **Clinic Google Sheets.** A reader on our side polls three tabs with the
   `clinic-sheets` service account. It does not use Zapier or the API key.
   The first successful read of each tab marks every patient already on it
   as seen and does not call. A later row is posted into the call flow with
   source `clinic_google_sheet`. The row needs a first name, a last name,
   and a phone number. The clinic name is added from which sheet it came
   from. Dane Functional Health sends the row only when column G is exactly
   `10-Day`. The same phone on the same sheet is sent once. Renaming a tab
   does not break the read (the tab is the gid). A new spreadsheet, or a
   renamed name or phone column, does. A failed read, including the robot
   being removed from the share, is a system log.

## Flows

Read live: `tsx debug/flow-poll.ts d2d421a8-47ef-4a1d-b8af-7e86a02a95f1`.

| Flow | State | Note |
| --- | --- | --- |
| Lead follow-up (white-glove build) | **off** | Stock webhook SMS ("book a visit"). Created disabled with the account. The owner asked the dashboard chat to delete it on 2026-09-23, then deleted it himself from the AiFlows trash icon at 14:24 UTC. It was restored and enabled the same day before we knew the delete was his. `bafitness-clinic-sheet-calls.ts` turns it back off. Do not enable it: the copy is the stock template, and its customer upsert would also fire the welcome email |
| GLP-1 Google Sheet Automation | on | Not a sheet watcher. Trigger is `contact_created`. It emails `{{vars.lead_email}}` a welcome from Coach Brett Douglas. `{{vars.lead_name.first}}` is a real first-name suffix, so that greeting is fine. It fires for every new contact, which is why the clinic call flow does not create one |
| FB Patient + Clinic Quinn call | **on** | Webhook, source `facebook_lead_ads` only. Waits 7 minutes, then Quinn `place_ai_call` 09:00-18:00 America/New_York Mon-Fri (`outside: defer`). Branches on `clinic_type`: blank/none uses the patient / consumer discovery script; any real clinic_type uses the clinic-owner partnership script. SMS with the booking link only on `no_answer` / `not_placed` / `failed`. No welcome email (James owns FB sequences). No `upsert_customer`, so the fitness-goal welcome does not also fire. Does not match `clinic_google_sheet` |
| Clinic sheet patient call | **on** | Webhook, source `clinic_google_sheet` only. If the row has an email, sends a clinic welcome from the Outlook mailbox already used by the Google Sheet automation. Waits 7 minutes, then `place_ai_call` from 09:00 to 18:00. Dane matches Pacific (`America/Los_Angeles`). Any other named clinic uses Eastern (`America/New_York`). After the call, one text with the booking link goes out only when the outcome is `no_answer`, `not_placed`, or `failed`. A live conversation is not texted, because there is no calendar connection to see whether they booked. A blank clinic name (`blank`) or the sentinel `none` notifies the owner and does not dial or text. Does not create a contact, so the fitness-goal welcome does not also fire. Outside the window the call defers (`outside: defer`) |

## The call

Quinn, on behalf of Coach Brett Douglas. Script is the one he pasted in
dashboard chat on 2026-09-23: book the intro call, no medical advice, no
pricing, partner names only if the patient asks (Dane: Fletcher, Eros
Vitality: Dr. Chris Potter, New Jersey Weight Loss Company: Al and Heidi).
Booking page: `https://cal.com/coachbrett/intro-to-10-day-wellness-coaching`.

There is no Acuity connection and no Cal.com connection. The call can hand
out the link. It must not say a time was booked unless calendar tools
actually showed an open slot. Do not connect Acuity unless he asks.

## Sharp edges

- The AiFlows trash icon used to delete on one click. He did that and did
  not remember it. The button now asks first.
- Dashboard chat told him it had staged wording and saved the call script,
  and told him to test Quinn by calling his personal cell. The chat now
  corrects a claim the tool result does not back, and the coworker phone in
  the prompt is the DID above.
- A blank Run now whose first step is `extract_text` used to fail the run
  and page System Errors (`extract_text: no message text to read`, 14:31 UTC
  on the email flow). The run route refuses that click. A manual run that
  still arrives with empty text is logged at info, not error.
- Do not replay the Facebook test leads from 2026-09-23. They arrived before
  the FB Quinn call was live; replaying them would contact those people now
  that `FB Patient + Clinic Quinn call` is enabled.
- Memory facts stored his three numbers as a bare `phone` predicate. The
  one-shot relabels the DID as `coworker_phone` and the forward number as
  `business_phone`. New owner-chat captures are told to keep the role.

## One-shots

- `bafitness-clinic-sheet-calls.ts` disables the stock follow-up, installs
  the clinic call (welcome email, 7 minute wait, call, then a text only if
  the call did not connect), and relabels the phone facts. Definition:
  `bafitness-clinic-sheet-definition.ts`. Dry-run by default. Applied
  2026-09-23, then again 2026-09-25 to add the email and the text.
- `bafitness-fb-lead-calls.ts` installs the Facebook Patient + Clinic Quinn
  call (7 minute wait, call, then a text only if the call did not connect)
  and keeps the stock follow-up off. Definition:
  `bafitness-fb-lead-calls-definition.ts`. Dry-run by default. Applied
  2026-09-25 (flow id `c0046b69-cf62-4b51-b559-c920d3eeda83`).
- `mint-kin-zapier-key.ts` minted the Zapier key (shared script, not
  BA-specific). The plaintext was shown once and is not stored here.
