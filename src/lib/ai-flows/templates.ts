/**
 * Curated, code-defined AiFlow templates the dashboard installs with one
 * click. These are authored here rather than aggregated into the
 * ai_flow_library catalog, which is rebuilt hourly from real tenant flows and
 * prunes anything it did not just publish.
 *
 * The ones listed in `libraryStarterTemplates()` are ALSO published to the
 * public library on every refresh (source 'starter'), so they survive that
 * prune: see src/lib/ai-flows/library-refresh.ts.
 *
 * Every template must pass `parseAiFlowDefinition`, enforced by unit test, so
 * the install path (POST /api/aiflows) can never 400 on our own template.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import { REVIEW_LINK_PLACEHOLDER } from "@/lib/ai-flows/scrub";

export type AiFlowTemplate = {
  /** Stable key (used by install callers and analytics). */
  key: string;
  /** Flow name the install creates. */
  name: string;
  /** One-line public description; required to publish to the library. */
  summary?: string;
  definition: AiFlowDefinition;
};

/** A template published to the public library: its summary is the catalog copy. */
export type LibraryStarterTemplate = AiFlowTemplate & { summary: string };

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
 * auto-texting starter can never fire for unrelated webhook events, e.g.
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
            "I'm on it. What's the best time to give you a quick call?"
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            // Whitespace separators only: a Meta lead form routinely carries a
            // phone OR an email, and notify_owner's collapseEmpty rendering
            // drops the space before an empty var but cannot remove ", " or
            // " / " around one (the live "Bobby, /. Details: none." artifact).
            "New Meta ad lead: {{vars.lead_name}} {{vars.lead_phone}} " +
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
 * source "instagram_scraper") is parsed, summarized to the owner, and, when
 * the profile carries a usable phone, filed as a contact tagged
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
              description:
                "The prospect's full name. Return an empty string when the content names " +
                "nobody: never a stand-in like 'there' or 'unknown', which would be filed " +
                "as this person's real name."
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
            // Whitespace separator between phone and email, same reasoning as
            // the Meta starter's brief. These vars are 'none'-sentineled, but
            // the copy must not depend on that staying true.
            "New Instagram prospect: {{vars.lead_name}} (@{{vars.lead_handle}}): " +
            "{{vars.lead_phone}} {{vars.lead_email}}. Notes: {{vars.lead_notes}}. " +
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

/**
 * Source label the direct Meta connection sends for an Instagram comment
 * (src/lib/meta/webhook.ts INSTAGRAM_COMMENT_FLOW_SOURCE). Duplicated here
 * rather than imported because this module is pulled into client bundles and
 * the webhook module is server-only; `tests/ai-flows-templates.test.ts` pins
 * the two to the same string so they can never drift apart.
 */
export const INSTAGRAM_COMMENT_SOURCE = "instagram_comment";

/**
 * "Instagram comment follow-up": the starter for the IG comment webhook.
 * Someone comments on the business's own Instagram post, and the owner gets a
 * brief with the handle, the comment, and what it's actually asking for, so a
 * buying question doesn't sit unseen under a photo for two days.
 *
 * It also answers the comment publicly, since holding a buyer for two days
 * under a photo is the thing this starter exists to stop. Public, not
 * private, on purpose: Instagram allows exactly ONE private reply per
 * comment, ever, and spending it on a generic acknowledgement would burn the
 * only message the owner has for the real answer. The `reply_to_comment`
 * step supports both, so an owner who wants the DM changes one setting.
 *
 * Still deliberately NO send_sms / upsert_customer step:
 *   - a comment carries a username, never a phone, and the CRM is phone-keyed,
 *     so "file them as a contact" would file nothing;
 *   - a commenter has not consented to texts or marketing email, the same rule
 *     the Instagram prospect starter follows.
 *
 * Installed DISABLED like the other starters, so the owner reads both the
 * public reply and the brief before anything reaches them or their post.
 */
export function instagramCommentTemplate(): LibraryStarterTemplate {
  return {
    key: "instagram_comment_follow_up",
    name: "Instagram comment follow-up",
    summary:
      "When someone comments on your Instagram post, your coworker reads it and " +
      "briefs you, flagging the ones actually asking to buy or book.",
    definition: {
      version: 1,
      trigger: {
        channel: "webhook",
        conditions: [{ type: "from_matches", value: INSTAGRAM_COMMENT_SOURCE }]
      },
      steps: [
        {
          id: "s_extract",
          type: "extract_text",
          fields: [
            {
              name: "commenter_handle",
              description:
                "The Instagram username of the person who commented, without the @. " +
                "'none' if the payload does not name one."
            },
            {
              name: "comment_text",
              description:
                "The comment, verbatim. Do not summarize, translate, or clean it up."
            },
            {
              name: "comment_intent",
              description:
                "What the comment is actually after, in a few words: 'asking the price', " +
                "'wants to book', 'asking a product question', 'complaint', 'just praise', " +
                "or 'spam'. Judge only from the comment text, never invent detail."
            }
          ]
        },
        {
          id: "s_reply",
          type: "reply_to_comment",
          replyMode: "public",
          // Answers the comment, promises nothing, and does not pretend to be
          // the owner. Spam gets no reply at all: a public "thanks!" under a
          // scam comment is worse than silence.
          body: "Thanks for the comment! We'll come back to you on this shortly.",
          when: { var: "comment_intent", notEquals: "spam" }
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            // Whitespace-only separators between vars, same reason as the Meta
            // and Instagram-prospect starters: a missing var must not leave a
            // dangling comma in the owner's alert.
            "New Instagram comment from @{{vars.commenter_handle}}: " +
            "\"{{vars.comment_text}}\" Looks like: {{vars.comment_intent}}. " +
            "I replied on the post so they know you saw it; the real answer is yours.",
          // Guarded to MATCH the reply step above. Without this the owner is
          // told "I replied" on exactly the comments the spam gate stopped us
          // replying to.
          when: { var: "comment_intent", notEquals: "spam" }
        },
        {
          id: "s_notify_owner_spam",
          type: "notify_owner",
          message:
            "New Instagram comment from @{{vars.commenter_handle}} looks like spam: " +
            "\"{{vars.comment_text}}\" I left it alone rather than replying under your post.",
          when: { var: "comment_intent", equals: "spam" }
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
 * link because it's per-business: the installer passes the owner's pasted
 * Google (or Yelp/Facebook) review URL, pre-cleaned by cleanReviewLink.
 * Installed DISABLED so the owner reviews the wording before anything fires.
 *
 * The send skips gracefully when the event carries no usable phone (the
 * send_sms planner's empty-recipient skip), so all-day blocks and internal
 * meetings never text anyone.
 */
export function reviewRequestTemplate(reviewLink: string): LibraryStarterTemplate {
  return {
    key: "review_request_after_appointment",
    name: "Ask for a review after appointments",
    summary:
      "An hour after a calendar appointment ends, your coworker texts the customer " +
      "your review link and briefs you.",
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
                "The customer/attendee's first name (not the business owner or organizer). " +
                "Return an empty string when the event names nobody: never a stand-in like " +
                "'there' or 'unknown', which would be filed as this person's real name."
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
          // to 'TBD' …" when the extracted phone wasn't usable, so this
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
 * very END of windowText, so a mail with no attachments never fires it, and
 * prose that merely says "attachments:" can't false-positive. Installed
 * DISABLED so the owner reviews the wording (and their connected sending
 * mailbox) first.
 *
 * No parameters: {{trigger.attachments}} carries the filenames and
 * {{trigger.from}} the sender, both supplied by the tenant_email scope.
 */
export function documentReceiptTemplate(): LibraryStarterTemplate {
  return {
    key: "document_receipt_confirmation",
    name: "Confirm document receipt",
    summary:
      "When someone emails documents to your AI mailbox, your coworker replies confirming " +
      "exactly which files arrived and briefs you.",
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
            "I emailed them a receipt confirmation, and the files are on your Emails page."
        }
      ]
    }
  };
}

/**
 * "Send new leads your price sheet": when a new lead texts in, extract their
 * details, file them, text them the chosen document as an expiring link, and
 * wait for the reply. Parameterized on the document because documents are
 * per-business: the installer passes the owner's picked doc (id + title),
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
export function newLeadIntakeTemplate(): LibraryStarterTemplate {
  return {
    key: "new_lead_intake",
    name: "New Lead Intake",
    summary:
      "Text your coworker a lead's name and number in plain words and it takes it from " +
      "there: the lead is filed, texted an intro (crediting whoever referred them), and " +
      "offered to your team, pinned to the teammate you name.",
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
            },
            {
              name: "lead_language",
              description:
                "Answer exactly es when the message says this lead speaks (or prefers) " +
                "Spanish. Otherwise answer exactly: none"
            },
            {
              name: "text_gate",
              description:
                "Answer exactly yes when the lead should be TEXTED: there is a phone " +
                "number and the message does not ask ONLY for a call. Otherwise answer " +
                "exactly: none"
            },
            {
              name: "call_gate",
              description:
                "Answer exactly yes when the message asks for the lead to be CALLED and " +
                "a phone number is given. Otherwise answer exactly: none"
            }
          ]
        },
        {
          id: "s_save_contact",
          type: "upsert_customer",
          when: { var: "has_phone", equals: "yes" },
          phoneVar: "lead_phone",
          nameVar: "lead_name",
          emailVar: "lead_email",
          // Stamps the language when the owner mentioned one, so later texts,
          // emails, and AI replies use it. Stored as a detection, so the lead's
          // own replies can still correct it.
          languageVar: "lead_language"
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
                  when: { var: "text_gate", equals: "yes" },
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
              when: { var: "text_gate", equals: "yes" },
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
          // "Call this lead": the AI places the call and does what it normally
          // does, then the owner gets the summary (notifyOwner, so the template
          // carries no tenant phone number). The lead is still routed below: a
          // call does not replace ownership of the lead.
          id: "s_call",
          type: "place_ai_call",
          when: { var: "call_gate", equals: "yes" },
          toVar: "lead_phone",
          personaTemplate:
            "Hi, is this {{vars.lead_name.first}}? I'm calling on behalf of the team " +
            "about your enquiry. Is now a good time for a couple of quick questions?",
          contextTemplate:
            "Their name: {{vars.lead_name}}. What they are looking for: " +
            "{{vars.lead_details}}. Never ask for details you were already given.",
          captureFields: ["what they are looking for", "their timeline", "best time to reach them"],
          notifyOwner: true,
          saveAs: "call_outcome"
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
            // No call-outcome line: {{vars.call_outcome}} only exists on runs
            // that placed a call, so elsewhere it would render as a bare
            // "Call outcome: ." The call step texts its own post-call summary
            // (notifyOwner) and actions_taken records that a call went out.
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

/**
 * Source label the Prospecting sweep sends after it has emailed a prospect
 * (src/lib/outreach/sweep.ts). Scoping the starter to it keeps this flow from
 * firing on unrelated webhook traffic.
 */
export const PROSPECT_OUTREACH_SOURCE = "prospect_outreach";

/** Tag every contacted prospect carries, so the owner can find them as a group. */
export const PROSPECT_TAG = "prospect";

/**
 * "Prospect outreach follow-through": what happens AFTER the coworker has
 * cold-emailed a prospect. The pitch itself is not here on purpose. It is
 * composed and sent in code (src/lib/outreach/sweep.ts) because it carries a
 * legally required unsubscribe link and postal address, and a flow step's body
 * is owner-editable copy that could lose them. What IS here is everything an
 * owner should be able to change: whether the prospect is filed, how they are
 * tagged, and what the owner is told.
 *
 * So this flow deliberately has NO send step. The email already went out before
 * the flow ran.
 *
 * It also has no owner notification, which is a change of mind worth recording.
 * It began with one, on the reasoning that the owner should hear what their
 * coworker did. In practice that is a text per prospect against a cap of twelve
 * a day, telling the owner a stranger received an email, which is the least
 * interesting moment in the whole sequence. The numbers live on the Marketing
 * page, the sent mail lives on the Emails page, and the notification an owner
 * actually wants (somebody REPLIED) already comes from the email coworker.
 * An owner who wants the running commentary can add a Notify me step here.
 *
 * Installed DISABLED like the other starters.
 */
export function prospectOutreachTemplate(): AiFlowTemplate {
  return {
    key: "prospect_outreach_follow_through",
    name: "Prospect outreach follow-through",
    definition: {
      version: 1,
      trigger: {
        channel: "webhook",
        conditions: [{ type: "from_matches", value: PROSPECT_OUTREACH_SOURCE }]
      },
      steps: [
        {
          id: "s_extract",
          type: "extract_text",
          fields: [
            {
              name: "prospect_name",
              description:
                "The prospect business's name. Return an empty string when the profile names " +
                "nobody: never a stand-in like 'there' or 'unknown', which would be filed as " +
                "this prospect's real name."
            },
            {
              name: "prospect_phone",
              description:
                "The prospect's phone number, digits and + only. You MUST return exactly " +
                "'none' (not an empty string) when there is no phone number."
            },
            {
              name: "prospect_email",
              description: "The prospect's email address. 'none' if there is none."
            },
            {
              name: "prospect_domain",
              description: "The prospect's website domain. 'none' if there is none."
            },
            {
              name: "prospect_vertical",
              description: "The trade or category the prospect was discovered under. 'none' if absent."
            }
          ]
        },
        {
          // The CRM is phone-keyed, so a prospect with no phone files no
          // contact rather than a broken one. They are still in the outreach
          // ledger and on the Marketing page either way.
          id: "s_file",
          type: "upsert_customer",
          phoneVar: "prospect_phone",
          nameVar: "prospect_name",
          when: { var: "prospect_phone", notEquals: "none" }
        },
        {
          id: "s_tag",
          type: "update_contact",
          phoneVar: "prospect_phone",
          addTags: [PROSPECT_TAG],
          when: { var: "prospect_phone", notEquals: "none" }
        }
      ]
    }
  };
}

/**
 * Category every starter is filed under in the public library, so the browse
 * page can group them together and filter them out.
 */
export const LIBRARY_STARTER_CATEGORY = "Starters";

/**
 * The curated templates published to the public library on every refresh.
 *
 * Definitions are published as authored (not scrubbed): they contain no
 * tenant data by construction, and the wording is the point. Parameterized
 * starters (today: the review request) ship with a sentinel URL the "Use this
 * flow" route replaces with an owner-pasted value. Install-only templates that
 * need a document pick (price sheet) stay out of this list until that path
 * exists.
 */
export function libraryStarterTemplates(): LibraryStarterTemplate[] {
  return [
    reviewRequestTemplate(REVIEW_LINK_PLACEHOLDER),
    documentReceiptTemplate(),
    newLeadIntakeTemplate(),
    instagramCommentTemplate()
  ];
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
            "A new texter ({{trigger.from}}) asked about your services, so I texted them " +
            "the document. Link I shared: {{vars.shared_doc_url}}"
        }
      ]
    }
  };
}
