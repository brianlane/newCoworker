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
 * @param replyDrafterAgentId `business_agents.id` of the reply drafter the
 *   applier upserts before authoring. Passed in rather than hardcoded because
 *   the agent is created by the same one-shot: a literal uuid here would be a
 *   promise the seeding step has to keep, and the two would drift the first
 *   time the agent was recreated.
 */
export function buildHqInboxTriageDefinition(replyDrafterAgentId: string) {
  return {
    version: 1,
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
              "Billing needing a human: an invoice we owe, a failed or declined payment, a dispute or chargeback. NOT receipts, successful charges, or server and hosting renewal or expiry notices"
          },
          {
            value: "automated_important",
            description:
              "Automated mail a human must act on: it asks us to do, verify, approve, confirm or respond to something, or reports an outage, security alert, suspension, broken integration or legal notice"
          },
          {
            value: "automated_bulk",
            description:
              "Bulk mail nobody ever needs to read again: marketing, newsletters, product announcements, promotions, webinar or event invitations, and vendor drip campaigns"
          },
          {
            value: "automated_notice",
            description:
              "Routine automated mail that asks nothing of us: our own alert and contact-form copies, calendar invites, digests, usage summaries, receipts, and hosting renewal or expiry notices"
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
            label: "Sales lead: draft a reply and ask",
            condition: { var: "email_kind", equals: "sales_lead" },
            steps: [
              {
                id: "s_draft",
                type: "run_agent",
                agentId: replyDrafterAgentId,
                // {{vars.approval_note}} is empty on the first pass and carries
                // Brian's words after he answers the gate with changes, which is
                // what makes the rewind do anything.
                // The recipient lines are load-bearing, not context padding:
                // without them the drafter addressed a prospect who was named
                // in the body but never on the email, so the reply reached
                // the introducer and nobody else.
                input:
                  "From: {{trigger.from}}\nTo: {{trigger.to}}\nCc: {{trigger.cc}}\nSubject: {{trigger.subject}}\n\n{{trigger.windowText}}\n\nOwner's requested changes (empty on the first draft): {{vars.approval_note}}",
                saveAs: "email_draft"
              },
              {
                id: "s_gate",
                type: "approval_gate",
                when: { var: "email_draft", notEquals: NO_REPLY_SENTINEL },
                allowModify: { redraftStepId: "s_draft" },
                // Parking this gate IS the alert for a sales lead, so it
                // carries the same one-text-per-conversation guarantee the
                // notify steps do. Without it, moving the paging from
                // notify_owner to the gate would have quietly undone #1191.
                cooldown: THREAD_COOLDOWN,
                prompt: `Sales email from {{trigger.from}} {{vars.email_sender}}. {{vars.email_gist}}\n\nDraft reply:\n{{vars.email_draft}}`
              },
              {
                id: "s_send",
                type: "send_email",
                when: { var: "email_draft", notEquals: NO_REPLY_SENTINEL },
                to: "{{trigger.from}}",
                subject: "Re: {{trigger.subject}}",
                body: "{{vars.email_draft}}",
                // Answers INSIDE the thread, and claims it, so every later
                // message on the conversation is handled autonomously.
                replyToEmailLogId: "{{trigger.email_log_id}}",
                fromConnectionId: GMAIL_CONNECTION_ROW_ID
              },
              {
                // The drafter declined (no new ask it could act on). Still tell
                // Brian: a real sales lead must never resolve to silence just
                // because the model had nothing to say.
                id: "s_notify_sales",
                type: "notify_owner",
                when: { var: "email_draft", equals: NO_REPLY_SENTINEL },
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
      {
        id: "s_org_sales",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        when: { var: "email_kind", equals: "sales_lead" },
        addLabels: ["HQ/Sales"],
        moveToFolder: "HQ/Sales"
      },
      {
        id: "s_org_support",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        when: { var: "email_kind", equals: "support" },
        addLabels: ["HQ/Support"],
        moveToFolder: "HQ/Support"
      },
      {
        id: "s_org_billing",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        when: { var: "email_kind", equals: "billing" },
        addLabels: ["HQ/Billing"],
        moveToFolder: "HQ/Billing"
      },
      /**
       * Routine automated mail: read it, file it, never mention it.
       *
       * Zapier and friends send mail with no working unsubscribe, so it
       * accumulated unread in the team inbox and every real message had to be
       * picked out of it. Until now `automated_notice` was classified and then
       * nothing happened to it, which is the worst of both: the run did the
       * work of recognising the mail and left it exactly where it was.
       *
       * ARCHIVED, not binned. This is the middle tier and it exists because
       * the two-tier version was destructive on every mistake: on Aug 9 2026
       * an email titled "[Action Needed] OAuth Verification Request
       * Acknowledgement", on a thread Brian had already replied to, was read
       * as routine and went to the Bin.
       *
       * A classifier will always be wrong sometimes, so the question is what
       * a wrong answer costs. Uncertain mail now lands here and is merely out
       * of the inbox, still in All Mail. Only the unmistakably-bulk tier below
       * is destroyed, and even that is recoverable for 30 days.
       */
      {
        id: "s_org_automated",
        type: "email_organize",
        connectionId: GMAIL_CONNECTION_ROW_ID,
        when: { var: "email_kind", equals: "automated_notice" },
        markRead: true,
        addLabels: ["HQ/Automated"],
        archive: true
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
        when: { var: "email_kind", equals: "automated_bulk" },
        markRead: true,
        addLabels: ["HQ/Automated"],
        trash: true
      },
      /**
       * The automated mail that DOES matter: an outage, a security alert, a
       * lapsing plan, a broken integration. One text, and the mail is left
       * UNREAD and in the inbox on purpose, so the owner's own inbox still
       * shows the thing needing action. Labelled but never archived.
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
        when: { var: "email_kind", equals: "automated_important" },
        markUnread: true,
        addLabels: ["HQ/Automated"]
      }
    ]
  };
}
