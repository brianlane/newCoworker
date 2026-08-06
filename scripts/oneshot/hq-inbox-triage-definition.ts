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
 * Gmail's multi-account index in the deep link. `u/0` is the FIRST account
 * signed in to the browser, not a stable id for this mailbox, so if the alert
 * link ever opens the wrong inbox this is the one character to change.
 */
export const GMAIL_ACCOUNT_INDEX = 0;

/**
 * Deep link to the triggering message. `#all/<id>` searches every folder, so
 * it still resolves after the email_organize steps move the mail out of the
 * inbox. Shortened to /s/<code> at send time, and deliberately untracked:
 * Brian tapping his own alert is not lead engagement.
 */
export const GMAIL_LINK = `https://mail.google.com/mail/u/${GMAIL_ACCOUNT_INDEX}/#all/{{trigger.message_id}}`;

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
              "Billing that needs a human: an invoice we must pay, a failed or declined payment, a dispute or chargeback, or a subscription problem. NOT routine receipts or confirmations of successful payments."
          },
          {
            value: "automated_notice",
            description:
              "Automated notifications, our own platform's alert/contact-form copies, calendar invites, newsletters, or marketing blasts, including receipts and payment confirmations for successful charges"
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
                input:
                  "From: {{trigger.from}}\nSubject: {{trigger.subject}}\n\n{{trigger.windowText}}\n\nOwner's requested changes (empty on the first draft): {{vars.approval_note}}",
                saveAs: "email_draft"
              },
              {
                id: "s_gate",
                type: "approval_gate",
                when: { var: "email_draft", notEquals: NO_REPLY_SENTINEL },
                allowModify: { redraftStepId: "s_draft" },
                prompt: `Sales email from {{trigger.from}} {{vars.email_sender}}. {{vars.email_gist}} ${GMAIL_LINK}\n\nDraft reply:\n{{vars.email_draft}}`
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
                message: `Sales email from {{trigger.from}} {{vars.email_sender}}. Subject: {{trigger.subject}}. {{vars.email_gist}} ${GMAIL_LINK}`
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
                message: `Support email from {{trigger.from}} {{vars.email_sender}}. Subject: {{trigger.subject}}. {{vars.email_gist}} ${GMAIL_LINK}`
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
                message: `Billing email from {{trigger.from}} {{vars.email_sender}}. Subject: {{trigger.subject}}. {{vars.email_gist}} ${GMAIL_LINK}`
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
      }
    ]
  };
}
