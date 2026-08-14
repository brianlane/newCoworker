# ChatGPT submission: sandbox, test cases, negative cases

Paste-ready content for the **Testing** step of the plugin submission. The test
cases name specific people and times, so they only pass against the sandbox
described below. Build the sandbox first.

---

## The sandbox

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

At least one open slot on the connected calendar in the next seven days.

If you use different names, change them in the cases below too. A test case
naming someone who does not exist reads as a broken app.

---

## Five test cases

### 1. Look up a customer

- **Scenario:** Find a customer and read their profile.
- **User prompt:** `Look up Maria Alvarez in New Coworker and tell me what you know about her.`
- **Tool triggered:** `search`, then `fetch`
- **Expected output:** Search returns Maria as both a contact and a conversation. Fetch returns her profile: name, phone, tags, when she was last in touch, and the assistant's rolling summary. The contact card renders inline. Each result carries a link back into the dashboard.

### 2. Read a conversation

- **Scenario:** Catch up on a text thread with a customer.
- **User prompt:** `Show me my text conversation with Maria Alvarez.`
- **Tool triggered:** `get_sms_thread` (usually after `search`)
- **Expected output:** The conversation renders in the message-thread widget, oldest first, with inbound and outbound distinguished. Content matches the seeded thread about moving her cleaning.

### 3. Review a phone call

- **Scenario:** Find out what a caller wanted without listening to a recording.
- **User prompt:** `What did my last call with Tom Becker cover?`
- **Tool triggered:** `list_call_transcripts`, then `fetch`
- **Expected output:** The call is listed with caller, time and status, and the summary says he asked about pricing. Fetching it returns the summary plus the transcript turns.

### 4. Check the calendar

- **Scenario:** Find open appointment times before offering one to a customer.
- **User prompt:** `What appointment times are open this week?`
- **Tool triggered:** `calendar_find_slots`
- **Expected output:** Up to three genuinely open slots render in the open-times widget, with each time shown in the business timezone (America/Phoenix), matching the timezone label on the card.

### 5. Send a text, with confirmation first

- **Scenario:** Reply to a customer by text from ChatGPT.
- **User prompt:** `Text Maria Alvarez that we can fit her in Thursday at 2pm.`
- **Tool triggered:** `send_sms` (after `search` to resolve her number)
- **Expected output:** **ChatGPT confirms before sending**, because the tool is annotated open-world and the server instructions require confirming anything that reaches a customer. After approval the message sends from the business number, the reply names the timezone rather than a bare "2pm", and the result reports the message id. The demo number is one we control, so no real person is contacted.

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
