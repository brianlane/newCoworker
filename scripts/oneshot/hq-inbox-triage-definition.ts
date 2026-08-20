/**
 * The HQ team-inbox triage flow's definition, extracted from its applier so
 * tests can pin the copy without the applier's env load and Supabase
 * connection running as a side effect (same split as
 * kyp-lead-flow-definition.ts).
 *
 * Why it is pinned: every defect this flow shipped on Aug 5 2026 was a quiet
 * one. An em dash rendered as a bare hyphen, a model-extracted subject came
 * back empty and left a hole in the text, and a reply on a thread Brian had
 * already been told about texted him again. None of it failed a test, because
 * none of it was under one. tests/oneshot-hq-inbox-triage-definition.test.ts
 * is that test.
 *
 * See setup-hq-inbox-triage-flow.ts for the operational notes (drift history,
 * how to apply).
 */

import { NO_REPLY_SENTINEL } from "./hq-inbox-reply-drafter.ts";

/** The HQ tenant (New Coworker, internal). */
export const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

/** Upsert key: the flow is looked up by name, so this must not change. */
export const FLOW_NAME = "Team inbox triage (HQ)";

/** workspace_oauth_connections.id of the HQ Google (Gmail) connection. */
export const GMAIL_CONNECTION_ROW_ID = "16cff2b9-b4d3-421c-b25d-b40edd80c9a8";

/**
 * NO LINK IN THE ALERT. Deliberate, after trying two.
 *
 * `mail.google.com/#all/<id>` opened Gmail on the WEB from a phone, so Brian
 * had to sign in and hunt for the message his own text had just summarized.
 * Swapping it for our own /dashboard/emails?id=<uuid> moved the login wall
 * rather than removing it: the dashboard still wants a session on a phone that
 * usually does not have one.
 *
 * So the text carries everything needed to act instead of a pointer to it: who
 * sent it, the subject, the ask, and the full draft. Approval is a digit
 * reply, which needs no browser at all. The mail is labelled and filed in
 * Gmail either way, so it is one search from the inbox when he does want it.
 */

/**
 * One text per Gmail conversation per working day. Brian got an intro AND its
 * "Re:" reply as two near-identical alerts minutes apart; the second carried
 * no new ask. A reply the next day is genuinely new and alerts again.
 */
export const THREAD_COOLDOWN = { key: "{{trigger.thread_id}}", minutes: 720 } as const;

/**
 * NEVER MARKS READ. Not one step, not one tier. Brian's rule, Aug 17 2026.
 *
 * Three `email_organize` steps used to carry `markRead: true`
 * (`automated_notice`, `billing_receipt`, `automated_bulk`), so mail that had
 * never been in front of a human arrived already read. Two live examples on
 * Aug 17: a Zoom Marketplace notice that our OAuth update was approved and
 * published, and a Telnyx notice that Global Voice Conversational rates change
 * on Aug 20. Both are routine by the classifier's definition and both are
 * things Brian wanted to actually see. The read mark is what hid them.
 *
 * The reasoning it replaced was sound but solved the wrong problem: bulk mail
 * with no working unsubscribe was piling up unread, and marking it read
 * cleared the badge. Labels already solve that, and they solve it without the
 * flow lying about what a human has looked at. An unread count that is honest
 * is worth more than an unread count that is small.
 *
 * `markUnread` is gone for the same reason, from the other direction: with
 * nothing marking mail read, forcing `automated_important` back to unread can
 * only ever undo a human who read it in the minute before the poll. Read state
 * belongs to the reader. This flow labels, stars, and bins; it does not touch
 * whether a message has been read.
 *
 * The OTHER path that can mark a triggering email read is the poller
 * (`markGmailMessageHandled` in src/lib/ai-flows/email-poll.ts), and it does
 * not reach this flow: it fires only for a flow with an UNCONDITIONAL
 * `send_email` on the trunk, and every send here sits inside the `b_sales`
 * branch behind a `when`. That predicate was deliberately narrowed for exactly
 * this flow; see its comment. Adding a trunk-level unguarded `send_email` here
 * would silently re-enable read-marking on every message the flow sees.
 *
 * `tests/oneshot-hq-inbox-triage-definition.test.ts` fails on any step that
 * sets either field, so this cannot come back by accident.
 */

/**
 * @param replyDrafterAgentId `business_agents.id` of the reply drafter the
 *   applier upserts before authoring. Passed in rather than hardcoded because
 *   the agent is created by the same one-shot: a literal uuid here would be a
 *   promise the seeding step has to keep, and the two would drift the first
 *   time the agent was recreated.
 */
export function buildHqInboxTriageDefinition(replyDrafterAgentId: string) {
  return {
    version: 1,
    /**
     * OUT OF THE DAILY SUMMARY. Brian's request, Aug 17 2026.
     *
     * This flow polls Gmail on a timer, so its run count tracks how much mail
     * arrived, not how much happened. The Aug 17 daily summary was 21 events,
     * 17 of them one line each reading "Team inbox triage (HQ), done", with the
     * day's single real call and single new customer underneath. The summary is
     * for the things Brian did not already watch happen; this flow texts him
     * the moment anything here needs him, so its runs are the one part of that
     * email he can never act on.
     *
     * Pinned here rather than left to the dashboard toggle for the same reason
     * everything else in this file is pinned: re-running the applier resets the
     * live row to this definition, so a preference that lived only in the
     * dashboard would silently revert on the next `--apply`.
     *
     * Note this is a DIFFERENT control from `digest_customer_facing_only`
     * (set on HQ by set-hq-digest-prefs.ts), which decides whether the digest
     * sends at all on a quiet day. That one did not help here: Aug 17 had a
     * real call and a real new customer, so the digest correctly sent, and then
     * buried both.
     */
    options: { hideFromDigest: true },
    trigger: {
      channel: "email",
      connectionId: GMAIL_CONNECTION_ROW_ID,
      conditions: []
    },
    steps: [
      {
        id: "s_extract",
        type: "extract_text",
        fields: [
          // No email_subject field: {{trigger.subject}} carries the real subject
          // line verbatim, for free. Asking the model to find it inside an
          // unlabeled "subject\nbody" blob is a guess, and on Aug 5 it guessed
          // "" and shipped an alert whose subject slot was simply blank.
          {
            name: "email_sender",
            description:
              "Who the sender is, as a person and a company, from the signature or the body. Format: 'Name (Company)'. Just the name if there is no company, and an empty string if neither is stated. The email address alone does not count, we already have it."
          },
          /**
           * DISPLAY ONLY, and anchored on purpose.
           *
           * Nothing branches on this number: it sorts the dashboard Emails page
           * so a day's mail can be skimmed worst-first. Routing stays on
           * `s_classify`, whose categories are prose that can be argued with.
           *
           * The bands exist because an unanchored 1-10 is where models cluster
           * and drift. Naming what a 3 and an 8 actually look like will not make
           * the score reproducible, but it keeps it roughly monotonic, which is
           * all an ordering needs. Digits-only because the value is templated
           * straight into `importanceTemplate`, and prose there scores nothing.
           */
          {
            name: "email_importance",
            description:
              "How much this needs Brian, 1-10, digits only. 1-2 bulk or ads; 3-4 routine notices; 5-6 a result we were waiting on, or a cost or policy change; 7-8 a customer or prospect awaiting a reply; 9-10 an outage, security problem, or failed payment. Judge the ask, not the sender's tone."
          },
          {
            name: "email_gist",
            description:
              "Max 18 words: what this sender wants DONE. Start with the ask ('Wants a demo of...', 'Needs pricing for...'), never with 'The sender' or 'They are'. Keep names, amounts, dates. Return an empty string if the message has no new ask (thanks, a thread correction, small talk)."
          }
        ]
      },
      {
        id: "s_classify",
        /**
         * Hosting renewal and expiry notices are deliberately ROUTINE, not
         * billing and not important.
         *
         * `src/lib/vps/billing-posture.ts` is the system of record for fleet
         * renewals: it runs on cron, resolves every VM's billing subscription,
         * auto-heals auto-renew for boxes a paying tenant depends on, reports
         * pool boxes that are leaking money, and honours an explicit
         * `never_renew` flag for boxes that MUST lapse at period end by design.
         *
         * This classifier can see none of that. It cannot tell a box we are
         * about to lose from one we chose to let go, so every such alert is a
         * coin flip and the wrong half is pure noise. Live example, Aug 6 2026:
         * Hostinger mailed that the KVM 2 plan on srv1800985 had expired and
         * the flow texted Brian about it. That was the retired residency-pilot
         * box (scripts/oneshot/retire-residency-pilot.ts): lapsing was the plan.
         *
         * A real payment problem (a declined card, a dispute, an invoice we
         * owe) is still `billing`, because no cron owns those.
         *
         * IT HAPPENED AGAIN, Aug 20 2026, 2:02pm, and the one-line exclusion
         * on `billing` was not enough. Hostinger mailed "Your KVM 8
         * srv1632631.hstgr.cloud has been canceled as we have not received
         * payment for the renewal", and the flow texted a billing alert.
         * srv1632631 is the KVM 8 pooled under the kvm2 label, flagged
         * `never_renew` in July precisely so it would lapse: at $73.99/mo it
         * costs more to renew than any tenant on it pays, and it had already
         * been retired in vps_inventory. Restoring it would have been the
         * wrong move, not the right one.
         *
         * That wording beat the guard because it matches the OTHER two
         * paging tiers on their own terms, and both had to be closed:
         *
         *   * `billing` names "a failed or declined payment", and "we have
         *     not received payment" is exactly that sentence. It is now
         *     scoped to a service we intend to KEEP, and names this case.
         *   * `automated_notice` opened with "asks nothing of us", which this
         *     mail violates twice ("View restore options", "please reply to
         *     this email"), disqualifying the very tier it belonged in. That
         *     clause is gone: what makes these routine is who owns the
         *     decision, not whether the sender wants a reply, so the tier now
         *     claims them "even expired, canceled, or asking us to restore".
         *   * `automated_important` names "suspension" and "asks us to
         *     respond" and would simply have caught the same mail on the
         *     rebound, since it texts too. Excluded there as well.
         *
         * Fixing only the tier that happened to win last time just moves the
         * false alarm to its neighbour, which is what the Aug 6 fix did.
         *
         * Note for the next edit: the authoring validator caps a category
         * description at 200 characters and all three of these sit within a
         * character or two of it. Room for a new clause has to be bought by
         * removing words, not appending them.
         */
        type: "classify",
        question: "What kind of email did the business just receive?",
        categories: [
          {
            value: "sales_lead",
            description:
              "A prospect making a NEW, actionable ask about New Coworker: pricing, features, a demo, setup, buying interest. A thank-you or thread-correction note is NOT this, even inside a sales thread"
          },
          {
            value: "support",
            description:
              "An existing customer or user needing help, reporting a problem, or asking an account question"
          },
          {
            value: "billing",
            description:
              "Billing on a service we KEEP: an invoice we owe, a declined card, a dispute or chargeback. NOT receipts for charges that succeeded, and NOT any hosting or server notice, even canceled for non-payment"
          },
          {
            value: "automated_important",
            description:
              "Automated mail we must act on: asks us to do, verify or respond, reports an outage, security alert, suspension or broken integration, OR continues a conversation we are in. NOT hosting notices"
          },
          {
            value: "billing_receipt",
            description:
              "A receipt, invoice or payment confirmation for a charge that already went through, from a vendor we pay: nothing is owed and nothing is broken, it is a record worth keeping"
          },
          {
            value: "automated_bulk",
            description:
              "Bulk mail nobody ever needs to read again and that we are not already corresponding on: marketing, newsletters, product announcements, promotions, event invitations, vendor drip campaigns"
          },
          /**
           * The middle rung, added Aug 17 2026 after the Zoom miss.
           *
           * "New Coworker OAuth has been updated and published" classified
           * `automated_notice` and was treated identically to a Slack "Find and
           * join channels" digest: labelled, silent, indistinguishable. Both
           * calls were defensible one at a time, which is the tell that the
           * tier itself was missing rather than the classifier being wrong.
           *
           * The signal built for exactly this case could not fire. Mail that
           * "continues a conversation we are in" is never routine, but
           * `thread_has_our_reply` only knows about EMAIL, and that update was
           * submitted through the Zoom Marketplace portal, so the thread had no
           * history at all. This description carries the knowledge that signal
           * could not: name the platforms, and the classifier can match on
           * sender and content without needing a thread.
           *
           * "DONE and needs no reply" is load-bearing, added Aug 18 2026 after
           * the nightly caught the other side of the same boundary. The first
           * wording named the platforms and stopped there, so it read as "any
           * mail about a review", and "Your app submission needs changes /
           * Respond with an updated build to continue" classified here: a
           * REJECTION that asks us to act, routed to the silent tier. The
           * previous rewrite guarded the neighbour below (hosting renewals
           * must stay routine) and not the neighbour above. An outcome that
           * still wants something from us belongs in `automated_important`,
           * which is the tier that texts; this one is only for the ones that
           * are finished.
           */
          {
            value: "automated_review",
            description:
              "A platform outcome that is DONE and needs no reply: our app review approved or published, a marketplace listing live, OAuth or domain verified, a rate change on a service we run on"
          },
          {
            value: "automated_notice",
            description:
              "Routine mail that asks nothing of us, not part of a conversation we are in: alert copies, calendar invites, digests. ANY hosting renewal or server notice, even canceled or asking us to restore"
          }
        ],
        saveAs: "email_kind"
      },
      /**
       * Sales leads get answered, not just announced.
       *
       * A branch rather than three `when` guards because a step's `when` takes
       * exactly ONE condition, and this arm needs both "it is a sales lead"
       * and "the drafter produced something". The arm supplies the first, so
       * the steps inside only have to test the second.
       *
       * The gate's own park text IS the alert here: one message carrying the
       * gist, the draft and the options, instead of an alert followed by a
       * separate approval prompt.
       */
      {
        id: "s_route",
        type: "branch",
        question: "How should this email be handled?",
        branches: [
          {
            id: "b_sales",
            label: "Sales lead: draft both notes and ask",
            condition: { var: "email_kind", equals: "sales_lead" },
            steps: [
              /**
               * TWO notes, not one, and they go out as two emails.
               *
               * A single reply-all thanking the introducer and pitching the
               * prospect reads oddly to both: each sees a paragraph written
               * for the other, and on a phone the recipient list is not even
               * visible, so it looks like a direct message that mentions a
               * stranger. Brian asked for them tailored (Aug 9 2026).
               *
               * The PROSPECT note first, because the gate's redraft rewinds to
               * the first step and both notes should be rewritten together
               * when he asks for changes.
               */
              {
                id: "s_draft_prospect",
                type: "run_agent",
                agentId: replyDrafterAgentId,
                input:
                  "WRITE: PROSPECT\n\n" +
                  "From: {{trigger.from}}\nTo: {{trigger.to}}\nCc: {{trigger.cc}}\nSubject: {{trigger.subject}}\n\n{{trigger.windowText}}\n\nOwner's requested changes (empty on the first draft): {{vars.approval_note}}",
                saveAs: "email_draft_prospect"
              },
              {
                id: "s_draft_intro",
                type: "run_agent",
                agentId: replyDrafterAgentId,
                input:
                  "WRITE: INTRODUCER\n\n" +
                  "From: {{trigger.from}}\nTo: {{trigger.to}}\nCc: {{trigger.cc}}\nSubject: {{trigger.subject}}\n\n{{trigger.windowText}}\n\nOwner's requested changes (empty on the first draft): {{vars.approval_note}}",
                saveAs: "email_draft_intro"
              },
              {
                // Gated on the INTRODUCER note: there is always a sender, so
                // that note exists whenever there is anything to say at all.
                // The prospect note is NO_REPLY when nobody else is on the
                // mail, and its send skips on the same condition.
                id: "s_gate",
                type: "approval_gate",
                when: { var: "email_draft_intro", notEquals: NO_REPLY_SENTINEL },
                allowModify: { redraftStepId: "s_draft_prospect" },
                // TWO sends sit behind this gate. Both "skip" and a cooling
                // gate advance past the steps they guard, and that advance is
                // one by default: without this, skipping would drop the
                // introducer note and still mail the prospect unapproved.
                guardsNextSteps: 2,
                //
                // NO COOLDOWN, deliberately, and this is a reversal.
                //
                // It used to carry THREAD_COOLDOWN so a second message on a
                // conversation Brian had already been texted about stayed
                // quiet (#1191). That made sense while the gate was an ALERT.
                // It is now the APPROVAL, and the coworker no longer answers
                // threads we have written on, so a cooled gate means a genuine
                // follow-up is classified, filed, and answered by nobody: no
                // reply, no text, silence. An approval that skips itself is
                // not an approval.
                //
                // The duplicate #1191 was about is still covered, by a better
                // guard: a message carrying no new ask makes the drafter
                // return NO_REPLY, so no gate parks and no text is sent, and
                // the fallback alert below keeps the cooldown so the OWNER
                // paging stays deduped.
                prompt:
                  "Sales email from {{trigger.from}} {{vars.email_sender}}. {{vars.email_gist}}\n\n" +
                  "To {{trigger.from}}:\n{{vars.email_draft_intro}}\n\n" +
                  "To {{trigger.others_to}}:\n{{vars.email_draft_prospect}}"
              },
              {
                id: "s_send_intro",
                type: "send_email",
                when: { var: "email_draft_intro", notEquals: NO_REPLY_SENTINEL },
                to: "{{trigger.from}}",
                subject: "Re: {{trigger.subject}}",
                body: "{{vars.email_draft_intro}}",
                // Threaded so it lands in the original conversation, but NOT
                // reply-all: mirroring would put the prospect back on this
                // note and undo the whole point of writing two.
                replyToEmailLogId: "{{trigger.email_log_id}}",
                replyAll: false,
                // The real sign-off: logo, founder, phone, from
                // branded-html.ts and docs/email-signatures.html. Composed by
                // the send path, never by the model, and only ever for the
                // platform's own business.
                brandedSignature: true,
                fromConnectionId: GMAIL_CONNECTION_ROW_ID
              },
              {
                // Skips itself when others_to renders empty, which is the
                // planner's templated-recipient skip path, and the drafter
                // returns NO_REPLY for the same case.
                id: "s_send_prospect",
                type: "send_email",
                when: { var: "email_draft_prospect", notEquals: NO_REPLY_SENTINEL },
                to: "{{trigger.others_to}}",
                cc: ["{{trigger.others_cc}}"],
                subject: "Re: {{trigger.subject}}",
                body: "{{vars.email_draft_prospect}}",
                replyToEmailLogId: "{{trigger.email_log_id}}",
                replyAll: false,
                // The real sign-off: logo, founder, phone, from
                // branded-html.ts and docs/email-signatures.html. Composed by
                // the send path, never by the model, and only ever for the
                // platform's own business.
                brandedSignature: true,
                fromConnectionId: GMAIL_CONNECTION_ROW_ID
              },
              {
                // The drafter declined outright. Still tell Brian: a real
                // sales lead must never resolve to silence.
                id: "s_notify_sales",
                type: "notify_owner",
                when: { var: "email_draft_intro", equals: NO_REPLY_SENTINEL },
                cooldown: THREAD_COOLDOWN,
                message: `Sales email from {{trigger.from}} {{vars.email_sender}}. Subject: {{trigger.subject}}. {{vars.email_gist}}`
              }
            ]
          },
          {
            id: "b_support",
            label: "Support: alert only",
            condition: { var: "email_kind", equals: "support" },
            steps: [
              {
                id: "s_notify_support",
                type: "notify_owner",
                cooldown: THREAD_COOLDOWN,
                message: `Support email from {{trigger.from}} {{vars.email_sender}}. Subject: {{trigger.subject}}. {{vars.email_gist}}`
              }
            ]
          },
          {
            id: "b_billing",
            label: "Billing: alert only",
            condition: { var: "email_kind", equals: "billing" },
            steps: [
              {
                id: "s_notify_billing",
                type: "notify_owner",
                cooldown: THREAD_COOLDOWN,
                message: `Billing email from {{trigger.from}} {{vars.email_sender}}. Subject: {{trigger.subject}}. {{vars.email_gist}}`
              }
            ]
          }
        ],
        // automated_notice and the reserved "unclear" land here: filed by the
        // organize steps below, and silent.
        else: []
      },
      /**
       * LABEL ONLY, never a folder move. In Gmail a move strips the INBOX
       * label, so triaged mail vanished from the inbox: Brian went looking
       * for the Bobby referral on Aug 8 2026 and could not find it, because
       * it was sitting under HQ/Sales alone. Nothing in this flow removes a
       * message from the inbox any more.
       */
      {
        id: "s_org_sales",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        importanceTemplate: "{{vars.email_importance}}",
        when: { var: "email_kind", equals: "sales_lead" },
        addLabels: ["HQ/Sales"]
      },
      {
        id: "s_org_support",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        importanceTemplate: "{{vars.email_importance}}",
        when: { var: "email_kind", equals: "support" },
        addLabels: ["HQ/Support"]
      },
      {
        id: "s_org_billing",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        importanceTemplate: "{{vars.email_importance}}",
        when: { var: "email_kind", equals: "billing" },
        addLabels: ["HQ/Billing"]
      },
      /**
       * Routine automated mail: file it, never mention it.
       *
       * Zapier and friends send mail with no working unsubscribe, so it
       * accumulated unread in the team inbox and every real message had to be
       * picked out of it. Until Aug 2026 `automated_notice` was classified and
       * then nothing happened to it, which is the worst of both: the run did
       * the work of recognising the mail and left it exactly where it was.
       *
       * LABELLED, and that is all. See NEVER MARKS READ below for why the
       * `markRead: true` this step used to carry is gone. Nothing in this flow
       * archives either: mail disappearing from the inbox is the complaint
       * that started this, and "where did it go" is a worse failure than an
       * unread message Brian can scroll past.
       *
       * This is still the tier uncertainty lands in, and it now costs
       * nothing at all: the message stays exactly where it was, in the state
       * it was in, filed under a label. Only the unmistakably-bulk tier below
       * is destroyed, and even that is recoverable for 30 days.
       */
      {
        id: "s_org_automated",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        importanceTemplate: "{{vars.email_importance}}",
        when: { var: "email_kind", equals: "automated_notice" },
        addLabels: ["HQ/Automated"]
      },
      /**
       * The review tier: worth Brian's eyes, not worth his phone.
       *
       * SILENT on purpose. Its whole reason for existing is that the choice was
       * previously "text him" or "make it look like a newsletter", and the
       * right answer for a Zoom publication notice is neither. A nested label
       * gives it its own row in Gmail's sidebar, so `HQ/Automated/Review` reads
       * at a glance as the pile worth skimming.
       *
       * A nested label rather than a star, deliberately: every starred message
       * in this mailbox is a payment receipt, and that signal is currently
       * clean. Two meanings on one star costs more than it buys.
       */
      {
        id: "s_org_review",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        importanceTemplate: "{{vars.email_importance}}",
        when: { var: "email_kind", equals: "automated_review" },
        addLabels: ["HQ/Automated/Review"]
      },
      /**
       * Receipts get STARRED, because that is what Brian does by hand.
       *
       * Read against the live mailbox before writing this: every starred
       * message in HQ's Gmail is a payment receipt or invoice (Anthropic,
       * Vercel, Supabase, Telnyx, Google Payments, Resend, Cursor, the
       * Arizona Corporation Commission), and all of them are left in the
       * inbox. So the flow does the same and they stay findable with
       * `is:starred`.
       */
      {
        id: "s_org_receipt",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        importanceTemplate: "{{vars.email_importance}}",
        when: { var: "email_kind", equals: "billing_receipt" },
        star: true,
        addLabels: ["HQ/Billing"]
      },
      /**
       * The only tier that bins anything: marketing and newsletters with no
       * working unsubscribe, which is what started this. Labelled first so a
       * misclassification is findable with `label:HQ/Automated in:trash`.
       */
      {
        id: "s_org_bulk",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        importanceTemplate: "{{vars.email_importance}}",
        when: { var: "email_kind", equals: "automated_bulk" },
        addLabels: ["HQ/Automated"],
        trash: true
      },
      /**
       * The automated mail that DOES matter: an outage, a security alert, a
       * lapsing plan, a broken integration. One text, and the mail is left
       * in the inbox on purpose, so the owner's own inbox still shows the
       * thing needing action. Labelled but never archived.
       */
      {
        id: "s_notify_automated",
        type: "notify_owner",
        when: { var: "email_kind", equals: "automated_important" },
        cooldown: THREAD_COOLDOWN,
        message: `Automated alert from {{trigger.from}} {{vars.email_sender}}. Subject: {{trigger.subject}}. {{vars.email_gist}}`
      },
      {
        id: "s_org_automated_important",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        importanceTemplate: "{{vars.email_importance}}",
        when: { var: "email_kind", equals: "automated_important" },
        addLabels: ["HQ/Automated"]
      }
    ]
  };
}
