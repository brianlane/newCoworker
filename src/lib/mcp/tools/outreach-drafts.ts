/**
 * Outreach queue tools: the review queue on Dashboard → Marketing ("Drafts to
 * review"), reachable from a connector.
 *
 * Why these exist. An outbound prospecting agent running in Claude, ChatGPT,
 * or Grok used to land its pitches as Gmail drafts, and Gmail is the wrong
 * inbox for a cold email: the Gmail API rewrites every https link into a
 * google.com/url?q= tracking wrapper, and the compliance footer (unsubscribe
 * link, postal address) has to ride in model output where it can be dropped.
 * The Marketing queue already solves both: the owner edits the MIDDLE of the
 * email, and the CTA, signature, and footer are assembled in code around it
 * at save and at send (src/lib/outreach/compose.ts, assembleBody). So these
 * tools write into that queue, through the same functions the dashboard's
 * Save draft, Skip, and the sweep's own drafting phase use.
 *
 * The body a caller passes is therefore the PARAGRAPHS only. No sign-off, no
 * booking link, no unsubscribe line, no address: those are added for them
 * and cannot be supplied, edited, or deleted here.
 *
 * Role bar is `manage_settings`, mirroring the dashboard outreach routes:
 * cold email leaves in the business's name, so it sits with the roster and
 * profile writes rather than the looser `operate_messages`.
 *
 * Send stays on the dashboard on purpose. `sendProspectNow` is safe to call
 * from anywhere (cap, mailbox, suppression re-check, assembled body), but the
 * owner's review is the point of manual mode, and a connector that can both
 * write a cold email and send it removes the one human read between a model
 * and a stranger's inbox. Callers are told the mode, because in `auto` mode
 * the sweep sends a drafted row itself inside the cap and window.
 */

import { z } from "zod";
import { McpToolError, requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import { rateLimit } from "@/lib/rate-limit";
import type { DraftUpsertResult, DraftUpdateResult } from "@/lib/outreach/sweep";

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Business whose Marketing queue this is. Optional when the account has exactly one business."
  );

/** Same budget as the dashboard's per-prospect route, on the connector's own key. */
const MCP_DRAFT_WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

/** Mirrors the dashboard route's ceilings (MAX_EDITED_*_CHARS in sweep.ts). */
const SUBJECT_MAX = 200;
const PARAGRAPHS_MAX = 4000;

/** Drafts one call returns; the dashboard's review queue shows 25. */
const LIST_DEFAULT = 25;
const LIST_MAX = 100;

const subjectField = z
  .string()
  .max(SUBJECT_MAX)
  .describe("The email's subject line. Concrete and non-deceptive: it names what the email is about.");

const paragraphsField = z
  .string()
  .max(PARAGRAPHS_MAX)
  .describe(
    "The editable body ONLY: greeting, observation, offer, ask, separated by blank lines. Do NOT include a sign-off, signature, booking link, unsubscribe line, or postal address; those are appended automatically and cannot be supplied here."
  );

/**
 * Owner-readable reasons, kept in step with the dashboard route's copy so a
 * refusal reads the same whichever surface asked.
 */
const UPSERT_FAILURE: Record<Extract<DraftUpsertResult, { ok: false }>["reason"], string> = {
  not_configured:
    "Finish setting up Prospecting first (Dashboard → Marketing: offer, footer address, mailbox).",
  tier_blocked: "Prospecting requires the Standard plan or higher.",
  empty_text: "A draft needs a subject line and something to say.",
  too_long: "That is longer than a cold email should be. Trim it and try again.",
  invalid_domain:
    "Could not work out the prospect's domain. Pass `domain` as their website's host (for example acmehvac.com).",
  duplicate:
    "This business's outreach ledger already has a prospect for that domain or email address that is past the draft stage (sent, replied, skipped, or unsubscribed), so it is not re-pitched: nobody is cold-emailed twice."
};

const UPDATE_FAILURE: Record<Extract<DraftUpdateResult, { ok: false }>["reason"], string> = {
  not_found: "That draft is no longer in the list.",
  not_drafted: "That draft has already been sent or skipped, so it can no longer be changed.",
  not_configured: "Finish setting up Prospecting first (Dashboard → Marketing).",
  tier_blocked: "Prospecting requires the Standard plan or higher.",
  empty_text: "A draft needs a subject line and something to say.",
  too_long: "That is longer than a cold email should be. Trim it and try again.",
  not_pitchable: "There is nothing specific enough left to say about this business. Skip it instead."
};

/** What a queue row looks like on the wire: the same fields the panel renders. */
const draftShape = z.object({
  draft_id: z.string(),
  business_name: z.string(),
  email: z.string().nullable(),
  domain: z.string(),
  city: z.string(),
  vertical: z.string(),
  subject: z.string().nullable(),
  /**
   * The editable middle. Null on a draft written before paragraphs were
   * stored separately: it can be skipped or regenerated on the dashboard but
   * not edited by subject alone, so update_outreach_draft needs paragraphs.
   */
  paragraphs: z.string().nullable(),
  status: z.string(),
  drafted_at: z.string().nullable()
});

type QueueRow = {
  id: string;
  business_name: string;
  email: string | null;
  domain: string;
  city: string;
  vertical: string;
  pitch_subject: string | null;
  pitch_paragraphs: string | null;
  status: string;
  drafted_at: string | null;
};

function toDraft(row: QueueRow): z.infer<typeof draftShape> {
  return {
    draft_id: row.id,
    business_name: row.business_name,
    email: row.email,
    domain: row.domain,
    city: row.city,
    vertical: row.vertical,
    subject: row.pitch_subject,
    paragraphs: row.pitch_paragraphs,
    status: row.status,
    drafted_at: row.drafted_at
  };
}

function takeWriteSlot(businessId: string): void {
  const limiter = rateLimit(`mcp-outreach-draft:${businessId}`, MCP_DRAFT_WRITE_RATE);
  if (!limiter.success) {
    throw new McpToolError("Too many draft writes in a minute, slow down.");
  }
}

export const listOutreachQueueTool = defineMcpTool({
  name: "list_outreach_queue",
  title: "List the outreach review queue",
  annotations: TOOL_BEHAVIOR.readLocal,
  outputSchema: z.object({
    /** off = the sweep ignores this business; manual = drafts wait; auto = drafts are SENT. */
    mode: z.enum(["off", "manual", "auto"]),
    waiting: z.number(),
    drafts: z.array(draftShape)
  }),
  description:
    "List the cold-outreach drafts waiting for review on Dashboard → Marketing (Drafts to review): prospect name, email, city, subject, and the editable body paragraphs (without the auto-appended sign-off and compliance footer). Also reports the prospecting mode: in auto mode drafts are sent by the sweep without a human pressing Send.",
  schema: {
    business_id: businessIdField,
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_MAX)
      .optional()
      .describe(`How many to return, oldest first. Default ${LIST_DEFAULT}, max ${LIST_MAX}.`)
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    const { countProspectsByStatus, getOutreachSettings, listProspectsByStatus } = await import(
      "@/lib/outreach/db"
    );
    const [settings, rows, waiting] = await Promise.all([
      getOutreachSettings(businessId),
      listProspectsByStatus(businessId, ["drafted"], args.limit ?? LIST_DEFAULT),
      countProspectsByStatus(businessId, "drafted")
    ]);
    return {
      mode: settings?.mode ?? "off",
      waiting,
      drafts: rows.map(toDraft)
    };
  }
});

export const upsertOutreachProspectTool = defineMcpTool({
  name: "upsert_outreach_prospect",
  title: "Add or re-pitch an outreach prospect",
  // Destructive because a prospect already in the queue (or discovered but
  // not yet drafted) has its subject, paragraphs, and identity fields
  // REPLACED. Open-world because in auto mode the sweep sends a drafted row
  // to the prospect's inbox inside the cap and window with no further human
  // action, so this call can put a cold email in motion.
  annotations: TOOL_BEHAVIOR.mutateExternal,
  outputSchema: z.object({
    /** False when an existing pre-send prospect was re-pitched instead of added. */
    created: z.boolean(),
    draft_id: z.string(),
    mode: z.enum(["off", "manual", "auto"]),
    subject: z.string().nullable(),
    paragraphs: z.string().nullable(),
    /** The email as it will be sent: paragraphs plus the appended CTA, signature, and footer. */
    assembled_body: z.string().nullable()
  }),
  description:
    "Add a cold-outreach prospect and its draft to Dashboard → Marketing (Drafts to review) for the owner to send, instead of a Gmail draft. Supply the prospect (name, email, city) and the email's subject and body PARAGRAPHS only: the booking link, sign-off, unsubscribe link, and postal address are appended automatically at save and send, and links stay clean. Upsert on the prospect's domain and email: a new prospect is added; one already waiting in the queue (or discovered but not yet drafted) has its draft and details replaced; one already sent, replied, skipped, or unsubscribed is refused. In auto prospecting mode the draft is sent by the sweep without further review, so check list_outreach_queue.mode first.",
  schema: {
    business_id: businessIdField,
    business_name: z.string().trim().min(1).max(200).describe("The prospect business's name."),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .describe("Where the email goes. Required: a draft with no address cannot be sent."),
    city: z
      .string()
      .trim()
      .max(120)
      .optional()
      .describe('Where the prospect is, as shown in the queue (for example "Tempe AZ").'),
    subject: subjectField,
    paragraphs: paragraphsField,
    domain: z
      .string()
      .trim()
      .max(253)
      .optional()
      .describe(
        "The prospect's website host (acmehvac.com), the key that stops anyone being emailed twice. Defaults to the email's domain; REQUIRED when the email is on a shared provider such as gmail.com."
      ),
    vertical: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe('The trade or search term this prospect belongs to (for example "hvac").'),
    website: z.string().trim().url().max(500).optional().describe("The prospect's website URL."),
    phone: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe(
        "The prospect's phone, if known. After a send, the outreach automation files the prospect as a contact by phone; without one they are emailed but not filed."
      )
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    takeWriteSlot(businessId);
    const { upsertProspectDraft } = await import("@/lib/outreach/sweep");
    const result = await upsertProspectDraft(businessId, {
      businessName: args.business_name,
      email: args.email,
      city: args.city ?? "",
      subject: args.subject,
      paragraphs: args.paragraphs,
      domain: args.domain,
      vertical: args.vertical,
      website: args.website,
      phone: args.phone
    });
    if (!result.ok) {
      throw new McpToolError(
        result.detail
          ? `${UPSERT_FAILURE[result.reason]} (${result.detail})`
          : UPSERT_FAILURE[result.reason]
      );
    }
    return {
      created: result.created,
      draft_id: result.prospect.id,
      mode: result.mode,
      subject: result.prospect.pitch_subject,
      paragraphs: result.prospect.pitch_paragraphs,
      assembled_body: result.prospect.pitch_body
    };
  }
});

export const updateOutreachDraftTool = defineMcpTool({
  name: "update_outreach_draft",
  title: "Edit or skip an outreach draft",
  // Replaces the stored subject/paragraphs, or retires the draft: destructive
  // by the spec's meaning. Nothing leaves the system on this call.
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: z.object({
    draft_id: z.string(),
    status: z.enum(["edited", "skipped"]),
    subject: z.string().nullable(),
    paragraphs: z.string().nullable(),
    assembled_body: z.string().nullable()
  }),
  description:
    "Change a waiting outreach draft on Dashboard → Marketing: a new subject and/or new body paragraphs (same as the dashboard's Save draft; the sign-off and compliance footer are re-appended automatically), or skip=true to retire it (same as the dashboard's Skip: the prospect is never rediscovered). Only a draft that has not been sent can be changed.",
  schema: {
    business_id: businessIdField,
    draft_id: z.string().uuid().describe("The draft_id from list_outreach_queue or upsert_outreach_prospect."),
    subject: subjectField.optional(),
    paragraphs: paragraphsField.optional().describe(
      "Replacement body paragraphs (editable middle only). Required for a draft whose paragraphs are null."
    ),
    skip: z
      .boolean()
      .optional()
      .describe(
        "true retires the draft without sending, and keeps this prospect out of future discovery. Cannot be combined with an edit."
      )
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    const editing = args.subject !== undefined || args.paragraphs !== undefined;
    if (args.skip && editing) {
      throw new McpToolError("Pass either skip=true or new text, not both.");
    }
    if (!args.skip && !editing) {
      throw new McpToolError("Nothing to update: pass subject, paragraphs, or skip=true.");
    }
    takeWriteSlot(businessId);

    if (args.skip) {
      const { skipProspect } = await import("@/lib/outreach/owner");
      // The queue can be minutes stale, so a skip that finds no draft is
      // reported rather than answered with a cheerful success.
      const skipped = await skipProspect(businessId, args.draft_id);
      if (!skipped) throw new McpToolError(UPDATE_FAILURE.not_drafted);
      return {
        draft_id: args.draft_id,
        status: "skipped" as const,
        subject: null,
        paragraphs: null,
        assembled_body: null
      };
    }

    // The dashboard posts both fields from its form. A connector may send
    // one, so the other is read from the row; editProspectDraft then applies
    // the same drafted-only guard and re-assembly the Save button gets.
    const { getProspect } = await import("@/lib/outreach/db");
    const current = await getProspect(businessId, args.draft_id);
    if (!current) throw new McpToolError(UPDATE_FAILURE.not_found);
    if (current.status !== "drafted") throw new McpToolError(UPDATE_FAILURE.not_drafted);

    const { editProspectDraft } = await import("@/lib/outreach/sweep");
    const result = await editProspectDraft(businessId, args.draft_id, {
      subject: args.subject ?? current.pitch_subject ?? "",
      paragraphs: args.paragraphs ?? current.pitch_paragraphs ?? ""
    });
    if (!result.ok) {
      throw new McpToolError(
        result.detail
          ? `${UPDATE_FAILURE[result.reason]} (${result.detail})`
          : UPDATE_FAILURE[result.reason]
      );
    }
    return {
      draft_id: args.draft_id,
      status: "edited" as const,
      subject: result.prospect.pitch_subject,
      paragraphs: result.prospect.pitch_paragraphs,
      assembled_body: result.prospect.pitch_body
    };
  }
});

export const outreachDraftTools = [
  listOutreachQueueTool,
  upsertOutreachProspectTool,
  updateOutreachDraftTool
];
