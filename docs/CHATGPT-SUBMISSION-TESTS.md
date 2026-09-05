# ChatGPT submission: sandbox, test cases, negative cases

Paste-ready content for the **Testing** step of the plugin submission. The test
cases name specific people and times, so they only pass against the sandbox
described below. Build the sandbox first.

---

## The sandbox

> **v1.0.0 was rejected twice.**
>
> 1. **2026-08-19:** "We're unable to complete your sign-in or OAuth flow."
>    The OAuth code was fine. There was **no sandbox tenant at all**, so the
>    Testing step's credentials field was empty. Build the sandbox BEFORE
>    filling the form, not after.
> 2. **2026-09-01:** "One or more of your test cases did not produce correct
>    results... consistently on both ChatGPT web and mobile." The five cases
>    below are the rewrite. They assert live MCP JSON, not widgets, not
>    ChatGPT confirmation UX, and not a calendar the sandbox does not have.
>
> **Resubmitted 2026-09-02 ~8:51 PM Phoenix.** Version
> `asdk_app_v_6a7eba8c28208191853a7554ffe2605a` is in REVIEW. Same 1.0.0
> string. Subtitle is `Look up and message customers` (30-character cap on
> Info; a longer phrase blocks Submit even when Testing is complete).

### Build it with the script

```bash
npx tsx debug/openai-reviewer-setup.ts            # dry run
npx tsx debug/openai-reviewer-setup.ts --apply
```

Idempotent, and it rotates both passwords on every `--apply`, so a rerun always
prints known-good credentials. It creates the owner login, a staff login on the
same business (the only thing that makes the reviewer test plan's permission
step a demonstration rather than a claim), the `Cedar Street Dental (demo)`
business in America/Phoenix, and the exact contacts, text thread and call
summary the five test cases name.

The credentials print to the terminal once. They go in the password manager and
the submission form, never in this repo.

Test case 5 sends a real text, so it needs a real destination:

```bash
npx tsx debug/openai-reviewer-setup.ts --apply --sms-target +1XXXXXXXXXX
```

That number is a flag rather than a constant because the only sensible values
are somebody's real phone, and personal numbers do not belong in a repo. Pass a
line with **no AI automation attached**, or our own coworker answers the
reviewer's test and texts the sandbox back. Without the flag, Maria keeps a
reserved `+1 555 01XX` number, the carrier rejects the send, and the reviewer
sees "Could not send".

The script also pins the sandbox's **from**-number to `+16023131823`, our own
New Coworker DID. That is not cosmetic. With no messaging row the sandbox falls
back to the shared platform profile, and Telnyx picks whichever number it
likes from a pool that contains paying customers' lines: a reviewer's demo text
would appear to come from a real customer, and a reply would land in that
customer's inbox.

The script cannot connect a calendar. Do not submit a `calendar_find_slots`
test case against this sandbox: that tool throws "No calendar is connected"
and was the Sep 1 rejection. Case 4 below reads the business profile instead.


OpenAI's wording is strict and each clause is a rejection if missed: test
credentials "must work immediately with no additional setup required. No
account creation or 2FA is permitted", and it must be "a dedicated demo or test
account with sample data only, and never a real user account with production
data."

**Create it through normal signup, not by hand in SQL.** A hand-built tenant
misses whatever provisioning does (number assignment, agent seeding, default
flows), and a reviewer hitting a half-provisioned business looks like a broken
app. Sign up the way a customer would, then seed the conversations.

### Requirements

| Requirement | Why |
| --- | --- |
| Email pre-confirmed, no MFA | A verification wall is an automatic fail |
| Business name obviously a demo | A reviewer should never wonder if this is a real customer's data |
| Contacts, texts and calls that are clearly fake | "Sample data only" |
| Outbound number points somewhere you control | A reviewer WILL run the send test case. It must not reach a real person |
| A second login on the same business with the **staff** role | Step 4 of the reviewer test plan is the only place permissions are shown to be enforced server-side rather than asserted |

Credentials go in the password manager and the submission form. Never in this
repo.

### Seed data the test cases below assume

Business: **Cedar Street Dental**, timezone America/Phoenix.

| Contact | Phone | State |
| --- | --- | --- |
| Maria Alvarez | +1 555 0142 | A short text thread about moving a cleaning |
| Tom Becker | +1 555 0177 | One completed call with a summary about pricing |
| Priya Nair | +1 555 0198 | Contact only, no messages |

Maria's live number is whatever `--sms-target` last set. The table above is
the fictional fallback, not a promise the reviewer will see `+15550142`.

If you use different names, change them in the cases below too. A test case
naming someone who does not exist reads as a broken app.

---

## Five test cases

Every prompt starts with `Using New Coworker,` so the reviewer does not have
to @-mention the app. Expected output is the MCP JSON shape, not a widget and
not ChatGPT's spoken reply. Widgets skip or fail on mobile, which is the
"web and mobile" clause in the Sep 1 rejection.

### 1. Look up a customer

- **Scenario:** Look up a customer and read their profile
- **User prompt:** `Using New Coworker, look up Maria Alvarez and tell me what you know about her.`
- **Tool triggered:** `search`, `fetch`
- **Expected output:** search returns two results for Maria Alvarez: a contact titled Maria Alvarez and a thread titled Text conversation with Maria Alvarez. Each result has an id and a url. fetch of the contact id returns text that includes Name: Maria Alvarez, Tags: patient, pinned notes about preferring late-afternoon appointments, and a rolling summary about moving her cleaning to Thursday afternoon. fetch is text-only. Do not require an inline widget. Same result shape on ChatGPT web and mobile.

### 2. Read a conversation

- **Scenario:** Read a text conversation with a customer
- **User prompt:** `Using New Coworker, show me my text conversation with Maria Alvarez.`
- **Tool triggered:** `search`, `get_sms_thread`
- **Expected output:** get_sms_thread returns an object with phone and messages, oldest first. The seeded thread includes an inbound message about moving a Tuesday cleaning and an outbound reply offering Thursday at 2:00 PM Arizona time. Directions are inbound and outbound. A conversation widget may appear on web. It is not required. Judge the JSON messages, not a widget. Same on ChatGPT web and mobile.

### 3. Review a phone call

- **Scenario:** Review what a phone call was about
- **User prompt:** `Using New Coworker, what did my last call with Tom Becker cover?`
- **Tool triggered:** `list_call_transcripts`, `fetch`
- **Expected output:** list_call_transcripts returns a calls array that includes Tom Becker's completed inbound call. The summary mentions a crown, pricing, and insurance. Each row has a fetch_id. fetch of that fetch_id returns text with a Summary section matching that, plus Transcript turns that include Delta Dental. No widget. Same on ChatGPT web and mobile.

### 4. Read the signed-in business

- **Scenario:** Read the signed-in business profile
- **User prompt:** `Using New Coworker, what is my business called and what timezone is it in?`
- **Tool triggered:** `list_businesses`, `get_business`
- **Expected output:** list_businesses returns exactly one business named Cedar Street Dental (demo), with role owner and tier standard. get_business returns timezone America/Phoenix and status online. No widget. Same on ChatGPT web and mobile.

### 5. Send a text

- **Scenario:** Send a customer a text from the business number
- **User prompt:** `Using New Coworker, text Maria Alvarez that we can fit her in Thursday at 2:00 PM Arizona time.`
- **Tool triggered:** `search`, `send_sms`
- **Expected output:** search resolves Maria. send_sms then returns sent true, her stored phone number in to, a non-empty message_id, and channel sms or rcs. Because send_sms is open-world, ChatGPT may show a confirmation before the tool runs. If it does, approve it. Do not require a widget. Do not require specific assistant reply wording. The MCP result after a successful send is sent true plus a message_id. Same on ChatGPT web and mobile.

---

## Three negative cases

These are prompts the app should **not** trigger on. Each is a near miss: the
verb or the noun overlaps with something we genuinely do, which is exactly when
a model reaches for the wrong tool.

### 1. Booking that is not an appointment

- **Scenario:** "Book" collides with our calendar booking, but travel is nothing we touch.
- **User prompt:** `Book me a flight to Denver next Thursday.`
- **Why it should not trigger:** Our booking tools put a customer on the business's own connected calendar. There is no travel, no purchasing, and no payment capability anywhere in the tool set.

### 2. A personal message, not a customer one

- **Scenario:** "Text someone" collides with `send_sms`, but the recipient is not a customer of the business.
- **User prompt:** `Text my wife that I'll be home late tonight.`
- **Why it should not trigger:** `send_sms` sends from the business's phone number to a customer, and it meters against the business's plan. A personal message to a family member is not that, and sending it from the business line would be wrong even if it delivered.

### 3. The owner's own agenda

- **Scenario:** "Calendar" collides with `calendar_find_slots`, but the question is about the owner's day.
- **User prompt:** `What meetings do I have tomorrow?`
- **Why it should not trigger:** `calendar_find_slots` reports times that are OPEN for booking a customer. It does not read the owner's personal agenda, and answering from it would invert the meaning of the result.

---

## Release notes

The **Submit** step has a required Release Notes field, and the form says these
notes "may be publicly displayed on the plugin details page". So this is
customer-facing copy, not reviewer-facing: no tool names, no sandbox details,
no test-plan pointers, and never credentials. Reviewer-only material belongs in
the test cases above and in the reviewer test plan page.

**Traps in the Submit step, found the hard way.**

1. The Submit step does NOT autosave and does NOT save on navigation. Every
   other step persists when you click Continue or switch sections; this one
   keeps the release notes only in browser state until the submission actually
   goes through. Leaving the page loses them, so paste this in during the same
   sitting you submit.
2. The policy checkboxes below the field are legal attestations about the
   business (terms, industry compliance, no money transfers, no ads, content
   rights, not aimed at under-13s). They are for the account owner to tick
   personally.
3. Info subtitle must be 30 characters or fewer. A longer phrase (for
   example `Look up customers, read texts and calls, send messages`) lights
   a Plugin issues banner and disables Submit for Review. Shorten it on
   Info, then return to Submit in the same sitting so the release notes are
   still in the box.
4. Do not click Scan Tools on MCP unless the form has no justifications.
   A re-scan would force re-justifying every tool and is a new rejection
   risk. The first Submit click can toast "Failed to save plugin changes";
   retry in the same sitting. Success is a "submitted for review" modal and
   version status REVIEW, not "Draft saved".

### v1.0, first release

```text
First release.

New Coworker is an AI coworker for small businesses. Connect your New Coworker
account and work with your customers, conversations and calendar without
leaving the chat.

What you can do:

Look someone up. Ask about a customer and get their profile, their text history
and what recent calls were about, pulled from your own account.

Catch up. Recent activity, your open tasks, your team roster, your automations
and your notification settings.

Get things done, with a confirmation first. Send a text or a WhatsApp message,
book onto your connected calendar, add or update a contact, and run one of your
own automations. Anything that reaches a customer is confirmed with you before
it happens.

See it, not raw data. Open appointment times, contact cards and text
conversations render right in the chat.

Signing in uses OAuth, so there is no API key to paste. Every action runs as you
and stays inside your team role and the businesses you already have access to.
Times in generated messages always name a timezone rather than a bare clock
time.

Available in the United States and Canada, in English and Spanish.
```

---

## Annotation justifications

The submission form asks, for every tool, why each of the three MCP behavior
annotations is accurate. That is 33 tools times 3 answers, and the answers are
the reviewable artifact: mis-annotating a tool is the most-cited cause of
rejection, so these are written against what each call sets in motion, not
against what its handler body happens to touch.

The annotation values below are generated from the live registry, and
`tests/chatgpt-submission-doc.test.ts` fails if a tool is added, removed, or
re-annotated without this file being updated in the same PR.

### `search`

- **Read Only: True** Runs SELECT-only queries across contacts, message threads and call transcripts for the businesses the caller holds a team role on. It writes nothing and returns the same results when called repeatedly.
- **Open World: False** It reads only our own Postgres database. No third-party API, no web fetch, and no outbound network call of any kind.
- **Destructive: False** It creates, modifies and removes nothing. The worst case is an empty result list.

### `fetch`

- **Read Only: True** Takes an id returned by search and reads that one record (contact, thread or call). Read path only: the id is an identifier and never an authorization, so the caller's live role is re-checked before anything is returned.
- **Open World: False** Reads only our own Postgres database. The id is parsed locally and is never used to reach an external service.
- **Destructive: False** Nothing is written or deleted. An unknown or unauthorized id returns a refusal, not a change.

### `list_businesses`

- **Read Only: True** Returns the businesses the signed-in account has a team role on. Pure SELECT, no writes.
- **Open World: False** Reads a single internal table. No external service is contacted.
- **Destructive: False** Nothing is created, changed or removed.

### `get_business`

- **Read Only: True** Reads one business profile row: name, timezone, phone number and plan. No writes.
- **Open World: False** Internal database read only, no third-party call.
- **Destructive: False** Read path with no mutation of any kind.

### `search_contacts`

- **Read Only: True** Matches a name, phone or email against the business's CRM contacts and returns the matches. SELECT only.
- **Open World: False** Queries our own contacts table. No external CRM or API is involved.
- **Destructive: False** No contact is created, edited or deleted.

### `get_contact`

- **Read Only: True** Reads one contact profile: name, phone, email, tags, owner, pinned notes and last interaction. No writes.
- **Open World: False** Internal database read. Nothing leaves our infrastructure.
- **Destructive: False** Nothing about the contact is modified.

### `get_sms_thread`

- **Read Only: True** Reads stored inbound and outbound messages for one conversation. It does not send and does not mark anything as read.
- **Open World: False** Reads message rows already stored in our database. No carrier or messaging API is called.
- **Destructive: False** No message is sent, edited or deleted.

### `list_recent_events`

- **Read Only: True** Reads the business's recent activity records (calls, messages, form submissions). SELECT only.
- **Open World: False** Internal database read, no external service.
- **Destructive: False** No event is created or removed.

### `list_call_transcripts`

- **Read Only: True** Lists stored voice call records with their summaries. Nothing is written and no call is placed.
- **Open World: False** Reads transcripts our voice pipeline already stored. No telephony API is called.
- **Destructive: False** No call record, recording or transcript is altered or deleted.

### `list_tasks`

- **Read Only: True** Reads the business's open task list. SELECT only.
- **Open World: False** Reads a task list our own system derives from stored activity. No external service is contacted.
- **Destructive: False** No task is created, completed or deleted.

### `send_sms`

- **Read Only: False** It sends a text message from the business's phone number and records the send, so it is not a read path.
- **Open World: True** It hands the message to our telephony provider for delivery to a real phone on the public network. The effect leaves our system entirely.
- **Destructive: False** Additive only: it appends a new outbound message. No existing message or record is overwritten or destroyed.

### `send_whatsapp`

- **Read Only: False** It sends a WhatsApp message from the business's number and logs the send. Not a read path.
- **Open World: True** Delivery goes through WhatsApp's platform to a real recipient outside our system.
- **Destructive: False** Additive only: it appends a new message and destroys nothing.

### `calendar_find_slots`

- **Read Only: True** It only reads availability. It queries free/busy and returns open times; it books nothing and writes nothing.
- **Open World: True** It reaches the business's connected third-party calendar (Google, Microsoft 365, Calendly, Vagaro or CalDAV), so the data comes from outside our system. That is why a read-only tool is still open-world here.
- **Destructive: False** No event is created, moved or cancelled. It is a lookup.

### `calendar_book_appointment`

- **Read Only: False** It creates a real appointment on the connected calendar, so it is a write.
- **Open World: True** The booking is written to the business's third-party calendar provider and can generate an invitation to the attendee.
- **Destructive: False** It adds a new event. It does not cancel, overwrite or delete an existing appointment.

### `create_contact`

- **Read Only: False** It inserts a new contact into the business's CRM.
- **Open World: True** Creating a contact fires the business's contact_created automations, and those automations can text or email the person. The effect reaches someone outside our system, which is why this is open-world rather than a purely local write.
- **Destructive: False** It only adds a record. It does not overwrite or remove an existing contact; a duplicate is reported rather than written over.

### `update_contact`

- **Read Only: False** It edits an existing contact record.
- **Open World: True** Tag and owner changes fire the same automations as a dashboard edit, and those automations can message the contact, so the effect can leave our system.
- **Destructive: True** Destructive because the tags argument REPLACES the existing tag set rather than adding to it, so prior pipeline state can be lost. Other supplied fields likewise overwrite the stored values.

### `list_employees`

- **Read Only: True** Reads the business's team roster. No writes.
- **Open World: False** Reads one internal roster table. No invitation, notification or third-party call is involved.
- **Destructive: False** No team member is added, changed or removed.

### `create_employee`

- **Read Only: False** It inserts a new team member onto the roster.
- **Open World: False** The write stays in our own database. This call sends no invitation and contacts no external service.
- **Destructive: False** Additive only: it creates a new record and overwrites nothing.

### `update_employee`

- **Read Only: False** It edits an existing roster member.
- **Open World: False** The change is confined to our own database; nothing is sent anywhere by this call.
- **Destructive: True** Destructive because supplied fields overwrite the stored values, an empty email clears the address, and deactivating someone or turning off lead rotation immediately redirects live leads away from them.

### `list_flows`

- **Read Only: True** Lists the business's automations with their names, triggers and enabled state. SELECT only.
- **Open World: False** Reads automation definitions from our own database. Listing them does not run any of them.
- **Destructive: False** No automation is created, edited, enabled or deleted.

### `get_flow`

- **Read Only: True** Reads one automation's full definition. No writes, and reading it does not run it.
- **Open World: False** Reads one automation definition from our own database. Reading a flow does not execute it.
- **Destructive: False** The automation is returned unchanged.

### `get_flow_schema`

- **Read Only: True** Returns the static schema describing the step types an automation can use. It reads no tenant data and writes nothing.
- **Open World: False** Served from code in our own application. No external call.
- **Destructive: False** Purely informational; nothing is modified.

### `create_flow`

- **Read Only: False** It inserts a new automation definition.
- **Open World: False** The new automation is stored in our database. Creating it does not run it and contacts nobody.
- **Destructive: False** Additive only: a new automation is created and no existing one is overwritten or removed.

### `update_flow`

- **Read Only: False** It edits an existing automation definition.
- **Open World: False** The change is stored in our database. Saving an automation does not run it.
- **Destructive: True** Destructive because the supplied step list replaces the stored one, so steps that are not resubmitted are lost.

### `list_flow_versions`

- **Read Only: True** It reads the recorded edit history of one automation and writes nothing.
- **Open World: False** A read of our own database, with no external call.
- **Destructive: False** A read, which changes nothing in the account.

### `restore_flow_version`

- **Read Only: False** It writes a previous definition back over the current one.
- **Open World: False** The write lands in our own database. Restoring an automation does not run it.
- **Destructive: True** Destructive because the definition that was live is replaced. It is recorded in the same history first, so the restore can itself be undone, but the live state is still overwritten.

### `set_flow_enabled`

- **Read Only: False** It changes an automation's enabled flag.
- **Open World: False** A flag write in our own database, with no external call.
- **Destructive: True** Marked destructive because disabling a flow silently stops work the business depends on. That is a loss of behavior even though no row is deleted.

### `trigger_flow`

- **Read Only: False** It queues real automation runs.
- **Open World: True** The matching automations execute and can text or email customers, so the effect reaches people outside our system.
- **Destructive: True** The flow body decides what happens, and an update_contact step inside a flow can carry removeTags, which deletes CRM state. We annotate to the worst case an owner-authored flow can reach, not to this handler's own writes.

### `run_flow`

- **Read Only: False** It starts an automation run immediately.
- **Open World: True** Same as trigger_flow: the run can send messages to customers through external providers.
- **Destructive: True** The automation body can remove tags and overwrite contact fields, so a run is not guaranteed additive. Annotated to what the run can do, not only to what this handler writes.

### `list_agents`

- **Read Only: True** Lists the business's AI agent configurations. SELECT only.
- **Open World: False** Reads agent configuration rows from our own database. No external model or service is called.
- **Destructive: False** No agent is created, changed or deleted.

### `create_agent`

- **Read Only: False** It inserts a new agent configuration.
- **Open World: False** Stored in our own database. Creating an agent does not by itself put it on a phone line or into a conversation.
- **Destructive: False** Additive only: nothing existing is overwritten or removed.

### `update_agent`

- **Read Only: False** It edits an existing agent configuration.
- **Open World: False** The write stays in our own database.
- **Destructive: True** Destructive because supplied fields, including the agent's instructions, overwrite the stored values.

### `delete_agent`

- **Read Only: False** It removes an agent configuration.
- **Open World: False** The deletion is confined to our own database.
- **Destructive: True** It permanently deletes the agent record and its past run history is removed with it. This is the clearest destructive case in the tool set.

### `update_notification_preferences`

- **Read Only: False** It changes which alerts the owner receives.
- **Open World: False** A settings write in our own database. No message is sent by this call.
- **Destructive: True** Destructive because each supplied toggle overwrites the stored value, and turning one off stops alerts the owner was relying on.

### `get_notification_preferences`

- **Read Only: True** Reads the owner's current alert toggles. No writes.
- **Open World: False** Reads one settings row from our own database. No external service is contacted.
- **Destructive: False** Nothing is created, changed or removed. It reports the current settings only.

### `update_business_profile`

- **Read Only: False** It writes the business's weekly hours and/or timezone to our database.
- **Open World: False** A profile write in our own database; the follow-up grounding refresh stays inside our platform. No message leaves and no third party is contacted.
- **Destructive: True** Destructive because a submitted day or timezone overwrites the stored value, and an explicit null closes a day that previously had hours.

### `get_business_knowledge`

- **Read Only: True** Reads the coworker's identity document from our database and splits it into sections. No writes.
- **Open World: False** Reads one row from our own database. No external service is contacted.
- **Destructive: False** Nothing is created, changed or removed. It reports the document's current sections only.

### `update_business_knowledge`

- **Read Only: False** It rewrites one section of the coworker's identity document (or appends a new one).
- **Open World: False** A document write in our own database; the follow-up knowledge-graph extract and agent sync stay inside our platform. No message leaves this call.
- **Destructive: True** Destructive because the targeted section's body is replaced with the new text; the previous wording of that section is gone after the write.

### `update_coworker_tool_settings`

- **Read Only: False** It writes per-surface tool policy rows that control what the coworker may do on each channel.
- **Open World: False** A settings write in our own database. No message is sent by this call.
- **Destructive: True** Destructive because each listed surface's stored setting is overwritten, and disabling a tool immediately removes a capability the coworker was using on that channel.

### `list_custom_tables`

- **Read Only: True** Reads the business's own table definitions and row counts from our database. No writes.
- **Open World: False** Reads rows from our own database. No external service is contacted.
- **Destructive: False** Nothing is created, changed or removed. It reports the current tables and their columns only.

### `get_custom_table_rows`

- **Read Only: True** Reads rows out of one table the business built for itself. No writes.
- **Open World: False** Reads rows from our own database, including an optional contact lookup that stays inside our platform. No external service is contacted.
- **Destructive: False** Nothing is created, changed or removed. It reports the rows that match the caller's filter only.

### `create_custom_table_row`

- **Read Only: False** It inserts a new row into one of the business's own tables.
- **Open World: False** A row insert in our own database. No message is sent and no third party is contacted.
- **Destructive: False** It only adds a row. No existing row is overwritten and nothing is removed.

### `update_custom_table_row`

- **Read Only: False** It writes new cell values onto an existing row in one of the business's own tables.
- **Open World: False** A row update in our own database. No message is sent by this call.
- **Destructive: True** Destructive because each submitted cell overwrites whatever that cell held before, and a cell submitted empty is cleared. The previous values are recoverable from the table's history for 90 days, but they are gone from the live row after the write.

### `delete_custom_table_row`

- **Read Only: False** It removes a row from one of the business's own tables.
- **Open World: False** A row delete in our own database. No message is sent and no third party is contacted.
- **Destructive: True** Destructive because the row leaves the live table immediately. A snapshot is kept in the table's history so the owner can restore it, but the row is no longer returned by any read once this call succeeds.

### `create_custom_table`

- **Read Only: False** It creates a new table for the business, with the columns the caller defined.
- **Open World: False** A table insert in our own database. No message is sent and no third party is contacted.
- **Destructive: False** It only adds a table. No existing table is changed and nothing is removed. A name that is already taken is refused rather than merged.

### `delete_custom_table`

- **Read Only: False** It marks one of the business's own tables as deleted.
- **Open World: False** A table update in our own database. No message is sent by this call.
- **Destructive: True** Destructive because the table and every row in it stop appearing anywhere in the product the moment this call succeeds. The delete is soft and the owner can restore it for 30 days, after which the table and its rows are purged for good.

### `restore_custom_table`

- **Read Only: False** It clears the deleted mark on a table so the table and its rows are live again.
- **Open World: False** A table update in our own database. No message is sent and no third party is contacted.
- **Destructive: True** Marked destructive because it changes what the business's live data contains: a table that was deliberately removed comes back, along with every row it held. It is refused when a live table already uses the same name, so it never overwrites one.

### `list_outreach_queue`

- **Read Only: True** Reads the cold-outreach drafts waiting for the owner's review, plus the prospecting mode. No writes.
- **Open World: False** Reads rows from our own database. No external service is contacted and nothing is sent.
- **Destructive: False** Nothing is created, changed or removed. It reports the drafts in the review queue only.

### `upsert_outreach_prospect`

- **Read Only: False** It inserts a new outreach prospect and draft (name, email, subject, body paragraphs) into the business's review queue, or re-pitches one already there.
- **Open World: True** Open-world because when the business has prospecting in automatic mode, the platform's sweep sends a drafted row to the prospect's email address inside the daily cap and send window without any further human action, so this call can put a cold email to an outside party in motion. In manual mode the owner presses Send on the dashboard first.
- **Destructive: True** Destructive because a prospect already waiting in the queue, or discovered but not yet drafted, has its stored subject, body paragraphs, and identity fields replaced by the submitted ones. A prospect already sent, replied, skipped, or unsubscribed is refused, never rewritten.

### `update_outreach_draft`

- **Read Only: False** It rewrites a waiting draft's subject and body paragraphs, or marks the draft skipped.
- **Open World: False** A row update in our own database. No message is sent by this call; sending remains a separate owner action or the sweep's, exactly as before the edit.
- **Destructive: True** Destructive because the submitted subject or paragraphs overwrite the stored text, and skip retires the draft so it will not be sent and the prospect will not be rediscovered.
