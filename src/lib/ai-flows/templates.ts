/**
 * Curated, code-defined AiFlow templates the dashboard installs with one
 * click (distinct from the ai_flow_library catalog, which is aggregated from
 * real tenant flows and pruned hourly — a curated starter would be deleted by
 * that refresh, so it lives here in code instead).
 *
 * Every template must pass `parseAiFlowDefinition` — enforced by unit test —
 * so the install path (POST /api/aiflows) can never 400 on our own template.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

export type AiFlowTemplate = {
  /** Stable key (used by install callers and analytics). */
  key: string;
  /** Flow name the install creates. */
  name: string;
  definition: AiFlowDefinition;
};

/**
 * Source label every Meta Lead Ads path sends: the direct connection
 * (src/lib/meta/webhook.ts), the Zapier action's default, and the Make.com
 * guide's request body.
 */
export const META_LEAD_ADS_SOURCE = "facebook_lead_ads";

/**
 * "Meta lead follow-up": the starter flow the Meta-leads How-To guide
 * installs. A webhook event (a lead forwarded by Zapier/Make from a Meta
 * Lead Ads form) is parsed with Gemini extraction, filed as a customer,
 * texted back within seconds, and summarized to the owner. Installed
 * DISABLED so the owner reviews the SMS wording before anything fires.
 *
 * Scoped to source "facebook_lead_ads" (every Meta path sends it) so this
 * auto-texting starter can never fire for unrelated webhook events — e.g.
 * scraped Instagram prospects (source "instagram_scraper"), who never
 * consented to texts. Backlog imports of Meta leads reach it by setting the
 * importer's source label to "facebook_lead_ads".
 */
export function metaLeadFollowUpTemplate(): AiFlowTemplate {
  return {
    key: "meta_lead_follow_up",
    name: "Meta lead follow-up",
    definition: {
      version: 1,
      trigger: {
        channel: "webhook",
        conditions: [{ type: "from_matches", value: META_LEAD_ADS_SOURCE }]
      },
      steps: [
        {
          id: "s_extract",
          type: "extract_text",
          fields: [
            { name: "lead_name", description: "The lead's full name" },
            {
              name: "lead_phone",
              description: "The lead's phone number, digits and + only"
            },
            { name: "lead_email", description: "The lead's email address" },
            {
              name: "lead_notes",
              description:
                "Everything else the lead provided: custom question answers, city, budget, timeframe. 'none' if nothing."
            }
          ]
        },
        {
          id: "s_file",
          type: "upsert_customer",
          phoneVar: "lead_phone",
          nameVar: "lead_name",
          emailVar: "lead_email"
        },
        {
          id: "s_text_lead",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body:
            "Hi {{vars.lead_name}}, thanks for your interest! I got your note and " +
            "I'm on it — what's the best time to give you a quick call?"
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            "New Meta ad lead: {{vars.lead_name}} — {{vars.lead_phone}} / " +
            "{{vars.lead_email}}. Details: {{vars.lead_notes}}. I texted them a hello; " +
            "they're filed in your customers."
        }
      ]
    }
  };
}

/**
 * Tag the Instagram-leads starter stamps on every filed prospect, so the
 * Marketing page (and campaign audience filters) can single them out for
 * owner review before any outreach.
 */
export const INSTAGRAM_PROSPECT_TAG = "instagram-prospect";

/** Source label the Instagram-leads guide tells bridges/imports to send. */
export const INSTAGRAM_SCRAPER_SOURCE = "instagram_scraper";

/**
 * "Instagram prospect intake": the starter flow the Instagram-leads How-To
 * guide installs. A webhook event (a scraped profile forwarded by an
 * Apify/Make/Zapier bridge, or a row from the lead-backlog importer with
 * source "instagram_scraper") is parsed, summarized to the owner, and —
 * when the profile carries a usable phone — filed as a contact tagged
 * `instagram-prospect`.
 *
 * Deliberately NO send_sms / send_email step: scraped prospects never gave
 * consent (TCPA / CAN-SPAM), so nothing is sent until the owner reviews the
 * contact and reaches out on their own terms. The owner brief runs FIRST
 * and never claims a filing happened: the file + tag steps after it are
 * gated on a phone being present (the CRM is phone-keyed), so phone-less
 * profiles still reach the owner with their handle and email while the
 * conditional steps skip. Installed DISABLED so the owner reviews the flow
 * before anything runs.
 */
export function instagramProspectTemplate(): AiFlowTemplate {
  return {
    key: "instagram_prospect_intake",
    name: "Instagram prospect intake",
    definition: {
      version: 1,
      trigger: {
        channel: "webhook",
        conditions: [{ type: "from_matches", value: INSTAGRAM_SCRAPER_SOURCE }]
      },
      steps: [
        {
          id: "s_extract",
          type: "extract_text",
          fields: [
            {
              name: "lead_name",
              description: "The prospect's full name. 'there' if unknown."
            },
            {
              name: "lead_phone",
              description:
                "The prospect's phone number, digits and + only. You MUST return exactly " +
                "'none' (not an empty string) when the profile has no phone number."
            },
            {
              name: "lead_email",
              description: "The prospect's email address. 'none' if the profile has no email."
            },
            {
              name: "lead_handle",
              description: "The prospect's Instagram username/handle. 'none' if not present."
            },
            {
              name: "lead_notes",
              description:
                "Everything else useful: bio, follower count, hashtag or search that found them, website. 'none' if nothing."
            }
          ]
        },
        {
          // The brief runs BEFORE the conditional filing so it always reaches
          // the owner and never claims a contact/tag that a phone-less
          // profile's gated steps skipped.
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            "New Instagram prospect: {{vars.lead_name}} (@{{vars.lead_handle}}) — " +
            "{{vars.lead_phone}} / {{vars.lead_email}}. Notes: {{vars.lead_notes}}. " +
            "I did NOT contact them (scraped prospects haven't consented to texts or " +
            "marketing email). If their profile has a phone number I'll file them in " +
            "your contacts tagged instagram-prospect next; otherwise add them yourself " +
            "from these details."
        },
        {
          id: "s_file",
          type: "upsert_customer",
          phoneVar: "lead_phone",
          nameVar: "lead_name",
          emailVar: "lead_email",
          when: { var: "lead_phone", notEquals: "none" }
        },
        {
          id: "s_tag",
          type: "update_contact",
          phoneVar: "lead_phone",
          addTags: [INSTAGRAM_PROSPECT_TAG],
          when: { var: "lead_phone", notEquals: "none" }
        }
      ]
    }
  };
}

/** Review links ride inside an SMS body (1600-char cap); keep them sane. */
export const REVIEW_LINK_MAX_LENGTH = 300;

/**
 * Normalize an owner-pasted review link for embedding in the template's SMS
 * body: trims, requires http(s), strips `{`/`}` so a pasted value can never
 * smuggle a `{{vars.x}}` reference into the flow (an unknown var would fail
 * validation and 400 the install), and caps the length. Returns null when
 * the value isn't usable as a link.
 */
export function cleanReviewLink(raw: string): string | null {
  const link = raw.trim().replace(/[{}]/g, "");
  if (link.length === 0 || link.length > REVIEW_LINK_MAX_LENGTH) return null;
  if (!/^https?:\/\/\S+$/i.test(link)) return null;
  return link;
}

/**
 * "Ask for a review after appointments" (the GHL Reviews-AI answer, minus
 * the platform lock-in): when a calendar appointment ENDS (plus a settle-in
 * hour), read the customer's name + phone off the event, text them the
 * business's review link, and brief the owner. Parameterized on the review
 * link because it's per-business — the installer passes the owner's pasted
 * Google (or Yelp/Facebook) review URL, pre-cleaned by cleanReviewLink.
 * Installed DISABLED so the owner reviews the wording before anything fires.
 *
 * The send skips gracefully when the event carries no usable phone (the
 * send_sms planner's empty-recipient skip), so all-day blocks and internal
 * meetings never text anyone.
 */
export function reviewRequestTemplate(reviewLink: string): AiFlowTemplate {
  return {
    key: "review_request_after_appointment",
    name: "Ask for a review after appointments",
    definition: {
      version: 1,
      trigger: {
        channel: "calendar",
        on: "event_end",
        followMinutes: 60,
        calendar: "both",
        conditions: []
      },
      steps: [
        {
          id: "s_extract",
          type: "extract_text",
          fields: [
            {
              name: "customer_name",
              description:
                "The customer/attendee's first name (not the business owner or organizer). 'there' if unknown."
            },
            {
              name: "customer_phone",
              description:
                "The customer's phone number, digits and + only. 'none' if the event has no customer phone."
            }
          ]
        },
        {
          // File the attendee as a contact before texting them, so the Texts
          // thread shows their name instead of a bare number (the Kav lesson,
          // Jul 24 2026: calendar-sourced people the flow texts must be
          // filed). Guarded: an event with no usable phone skips the step.
          id: "s_file",
          type: "upsert_customer",
          phoneVar: "customer_phone",
          nameVar: "customer_name",
          when: { var: "customer_phone", notEquals: "none" }
        },
        {
          id: "s_text_review",
          type: "send_sms",
          to: "{{vars.customer_phone}}",
          body:
            "Hi {{vars.customer_name}}, thanks for coming in today! If you had a " +
            "good experience, would you mind leaving us a quick review? It really " +
            `helps: ${reviewLink}`
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          // {{vars.actions_taken}} is the engine's truthful ledger of what
          // actually went out: "texted +1602… " on a send, "skipped a text
          // to 'TBD' …" when the extracted phone wasn't usable — so this
          // brief can never claim a text that the send step skipped.
          message:
            "Appointment \u201c{{trigger.event_title}}\u201d wrapped up. Review " +
            "request for {{vars.customer_name}}: {{vars.actions_taken}}",
          when: { var: "customer_phone", notEquals: "none" }
        }
      ]
    }
  };
}

/**
 * "Confirm document receipt": when the AI coworker's own mailbox receives
 * an email carrying attachments, email the sender a receipt confirmation
 * (naming the files) and brief the owner. The trigger is a regex anchored
 * to the `[inbound attachments] …` line the inbound path appends to the
 * very END of windowText — a mail with no attachments never fires it, and
 * prose that merely says "attachments:" can't false-positive. Installed
 * DISABLED so the owner reviews the wording (and their connected sending
 * mailbox) first.
 *
 * No parameters: {{trigger.attachments}} carries the filenames and
 * {{trigger.from}} the sender, both supplied by the tenant_email scope.
 */
export function documentReceiptTemplate(): AiFlowTemplate {
  return {
    key: "document_receipt_confirmation",
    name: "Confirm document receipt",
    definition: {
      version: 1,
      trigger: {
        channel: "tenant_email",
        // Anchored to the end of windowText, where the inbound path appends
        // the marker line (see EMAIL_ATTACHMENTS_MARKER in trigger-eval).
        conditions: [{ type: "regex", value: "\\n\\[inbound attachments\\] .+$" }]
      },
      steps: [
        {
          id: "s_confirm",
          type: "send_email",
          to: "{{trigger.from}}",
          subject: "We received your documents",
          body:
            "Hi,\n\nJust confirming we received your file(s): {{trigger.attachments}}.\n\n" +
            "Our team will review them and follow up if anything else is needed.\n\nThank you!"
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            "Documents received from {{trigger.from}}: {{trigger.attachments}}. " +
            "I emailed them a receipt confirmation — the files are on your Emails page."
        }
      ]
    }
  };
}

/**
 * "Send new leads your price sheet": when a new lead texts in, extract their
 * details, file them, text them the chosen document as an expiring link, and
 * wait for the reply. Parameterized on the document because documents are
 * per-business — the installer passes the owner's picked doc (id + title),
 * and the save-time validator refuses anything that isn't a real, ready,
 * client-facing document of theirs.
 */
/**
 * "New Lead Intake": the owner texts (or types to) their coworker a lead's
 * info in plain words, e.g. "I got a new lead, please deal with it. Jane
 * +15551234567, looking for a quote. It's a referral from Donald. I want
 * Gabby to have this." Run on demand (the operator's run_aiflow offers it
 * by name), the flow parses the message, files the contact, texts the lead
 * an intro (opening with a personal referral credit when a referrer was
 * named), and offers the lead to the team, pinned DYNAMICALLY to the
 * teammate the owner named via route_to_team.agentNameVar, so new hires
 * are pinnable the day they join the roster. Installed DISABLED so the
 * owner reviews (and personalizes) the intro wording before anything fires.
 *
 * Industry-neutral on purpose: no vertical-specific pitch, no quiet-hours
 * timezone baked in. Owners tailor the copy in the editor after install.
 */
export function newLeadIntakeTemplate(): AiFlowTemplate {
  return {
    key: "new_lead_intake",
    name: "New Lead Intake",
    definition: {
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "s_parse",
          type: "extract_text",
          fields: [
            {
              name: "lead_name",
              description:
                "The lead's name as given (first and last if provided, else the first " +
                "name alone). Never the sender's own name. If no name is given, answer " +
                "exactly: none"
            },
            {
              name: "lead_phone",
              description:
                "The NEW lead's phone number in E.164 (+1...). Never the business's own " +
                "number. If no phone number is given, answer exactly: none"
            },
            {
              name: "lead_email",
              description: "The lead's email address, if given. If none, answer exactly: none"
            },
            {
              name: "lead_details",
              description:
                "What the lead is looking for, in the message's own words, including who " +
                "referred them when the message says so. If nothing is given, answer " +
                "exactly: none"
            },
            {
              name: "referred_by",
              description:
                "The name of the person who referred this lead, when the message says it " +
                "is a referral (e.g. 'a referral from Donald' answers: Donald). If it is " +
                "not a referral or no referrer is named, answer exactly: none"
            },
            {
              name: "referral_gate",
              description:
                "If the message says this lead was referred by a NAMED person, answer " +
                "exactly one lowercase word: referral. Otherwise answer exactly: none"
            },
            {
              name: "assigned_agent",
              description:
                "The teammate's name exactly as the message wrote it, when the message " +
                "says a specific teammate should get or handle this lead (e.g. 'I want " +
                "Gabby to have this' answers: Gabby). If no teammate is named, answer " +
                "exactly: none"
            },
            {
              name: "has_phone",
              description:
                "If the message includes a phone number for the lead, answer exactly: " +
                "yes. Otherwise answer exactly: none"
            },
            {
              name: "email_only",
              description:
                "If the message gives NO phone number for the lead but DOES give an " +
                "email address, answer exactly: yes. Otherwise answer exactly: none"
            }
          ]
        },
        {
          id: "s_save_contact",
          type: "upsert_customer",
          when: { var: "has_phone", equals: "yes" },
          phoneVar: "lead_phone",
          nameVar: "lead_name",
          emailVar: "lead_email"
        },
        {
          id: "s_intro",
          type: "branch",
          question: "Was this lead referred by a named person?",
          branches: [
            {
              id: "s_intro_referral",
              label: "Referral with a named referrer",
              condition: { var: "referral_gate", equals: "referral" },
              steps: [
                {
                  id: "s_send_ref",
                  type: "send_sms",
                  to: "{{vars.lead_phone}}",
                  when: { var: "has_phone", equals: "yes" },
                  body:
                    "Hi {{vars.lead_name.first}}. {{vars.referred_by}} shared your info " +
                    "with me and thought I could help. I'm so glad they connected us! " +
                    "When is a good time for a quick chat about what you're looking for?"
                },
                {
                  id: "s_email_ref",
                  type: "send_email",
                  to: "{{vars.lead_email}}",
                  when: { var: "email_only", equals: "yes" },
                  subject: "Great to be connected!",
                  body:
                    "Hi {{vars.lead_name.first}},\n\n{{vars.referred_by}} shared your " +
                    "info with me and thought I could help. I'm so glad they connected " +
                    "us! When is a good time for a quick chat about what you're looking " +
                    "for?"
                }
              ]
            }
          ],
          else: [
            {
              id: "s_send_std",
              type: "send_sms",
              to: "{{vars.lead_phone}}",
              when: { var: "has_phone", equals: "yes" },
              body:
                "Hi {{vars.lead_name.first}}. Thanks for reaching out! I'd love to " +
                "help. When is a good time for a quick chat about what you're looking " +
                "for?"
            },
            {
              id: "s_email_std",
              type: "send_email",
              to: "{{vars.lead_email}}",
              when: { var: "email_only", equals: "yes" },
              subject: "Thanks for reaching out!",
              body:
                "Hi {{vars.lead_name.first}},\n\nThanks for reaching out! I'd love to " +
                "help. When is a good time for a quick chat about what you're looking " +
                "for?"
            }
          ]
        },
        {
          id: "s_route",
          type: "route_to_team",
          when: { var: "has_phone", equals: "yes" },
          // Dynamic pin: when the owner named a teammate, the offer goes to
          // exactly that active roster member (resolved at run time, so new
          // hires work immediately); empty/none = the normal rotation.
          agentNameVar: "assigned_agent",
          responseMinutes: 10,
          offerTemplate:
            "New lead: {{vars.lead_name}} ({{vars.lead_phone}}, email: " +
            "{{vars.lead_email}}). Looking for: {{vars.lead_details}}.\n" +
            "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
            'You can also reply "1, <ETA>" to claim and say when you\'ll reach out.',
          claimedNotifyTemplate:
            "{{agent.name}} claimed the lead {{vars.lead_name}} ({{vars.lead_phone}}).",
          ownerFallbackTemplate:
            "No one claimed the lead {{vars.lead_name}} ({{vars.lead_phone}}, email: " +
            "{{vars.lead_email}}) in time. It's back with you."
        },
        {
          id: "s_notify",
          type: "notify_owner",
          when: { var: "has_phone", equals: "yes" },
          message:
            "New Lead Intake handled the lead you sent in.\n" +
            "Lead: {{vars.lead_name}} ({{vars.lead_phone}}, email: {{vars.lead_email}}). " +
            "Looking for: {{vars.lead_details}}.\n" +
            "Outcome: {{vars.actions_taken}}."
        },
        {
          id: "s_notify_no_phone",
          type: "notify_owner",
          when: { var: "has_phone", equals: "none" },
          message:
            "New Lead Intake got a lead with NO usable phone number, so no text went " +
            "out and no one was offered the lead.\n" +
            "Lead: {{vars.lead_name}} (email: {{vars.lead_email}}). Looking for: " +
            "{{vars.lead_details}}.\n" +
            "If an email was on file, an intro email was sent instead; the outcome " +
            "line shows exactly what went out.\n" +
            "Outcome: {{vars.actions_taken}}."
        }
      ]
    }
  };
}

export function priceSheetShareTemplate(documentId: string, documentTitle: string): AiFlowTemplate {
  return {
    key: "price_sheet_share",
    name: "Send new leads your price sheet",
    definition: {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "s_share",
          type: "share_document",
          documentId,
          documentTitle,
          to: "{{trigger.from}}",
          via: "sms",
          messageTemplate: "Thanks for reaching out! Here it is: {{share_url}}",
          saveAs: "shared_doc_url"
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            "A new texter ({{trigger.from}}) asked about your services — I texted them " +
            "the document. Link I shared: {{vars.shared_doc_url}}"
        }
      ]
    }
  };
}
