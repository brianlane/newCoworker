/**
 * Meeting-minutes classification: the writes.
 *
 * Turns a classified meeting into the four things an owner would otherwise
 * do by hand after a call:
 *
 *   1. link the minutes to the contact, so they live on the person's record
 *      and not only in the library,
 *   2. file a note saying what the meeting was,
 *   3. move the pipeline card, through the platform's own lifecycle machinery
 *      (and therefore behind all of its guards),
 *   4. file the action items as to-dos, assigned when the minutes name
 *      somebody on the roster.
 *
 * Each write is INDEPENDENTLY guarded. A failed to-do must not cost the
 * note, and none of them may throw: the import that discovered this meeting
 * already succeeded, and a document in the library is the valuable part.
 *
 * `scheduleMeetingClassification` is the entry point the import calls. It
 * runs the whole pass after the HTTP response flushes, same rationale and
 * same `after()` guard as `scheduleLongFormGraphExtract`.
 */
import { after } from "next/server";
import { patchBusinessDocument } from "@/lib/documents/db";
import { createContactNote } from "@/lib/notes/db";
import { createTodo } from "@/lib/todos/db";
import { listTeamMembers } from "@/lib/db/employees";
import { recordSystemLog } from "@/lib/db/system-logs";
import { fireLifecycleStage } from "@/lib/pipelines/lifecycle-hooks";
import {
  getZoomTranscriptClassification,
  stampZoomTranscriptClassification
} from "@/lib/db/zoom-transcript-imports";
import { logger } from "@/lib/logger";
import { classifyMeeting } from "./classify";
import { resolveMeetingContact } from "./resolve-contact";
import {
  buildMeetingNoteBody,
  buildMeetingTodoDetails,
  MEETING_OUTCOME_EVENT,
  MEETING_OUTCOME_UNCLEAR,
  outcomeTouchesContact,
  type MeetingActionItem,
  type MeetingOutcome
} from "./outcome-core";

/** The note's author, where a human's display name would go. */
export const MEETING_NOTE_AUTHOR_LABEL = "AI coworker";

/** Owner-facing activity trail, matching the zoom-webhook source convention. */
export const MEETING_CLASSIFY_LOG_SOURCE = "zoom-meeting-classify";

export type MeetingClassificationInput = {
  businessId: string;
  /** The document the import just produced. */
  documentId: string;
  documentTitle: string;
  /** Condensed minutes, what the classifier reads. */
  minutes: string;
  /** The document's retrieval summary, quoted into the note. */
  summary: string | null;
  /** Raw WebVTT, for contact-resolution fallbacks. */
  vtt: string;
  /** Zoom's past-meeting instance UUID: the ledger key and the dedupe suffix. */
  meetingUuid: string;
  /** Zoom's numeric meeting id, the booking-ledger join key. */
  zoomMeetingId: string | null;
  /** Names that count as "us" when picking the guest. */
  hostNames: string[];
};

export type ApplyMeetingOutcomeDeps = {
  classify?: typeof classifyMeeting;
  resolveContact?: typeof resolveMeetingContact;
  patchDocument?: typeof patchBusinessDocument;
  createNote?: typeof createContactNote;
  createTodoFn?: typeof createTodo;
  listMembers?: typeof listTeamMembers;
  fireStage?: typeof fireLifecycleStage;
  stampLedger?: typeof stampZoomTranscriptClassification;
  readClassification?: typeof getZoomTranscriptClassification;
  logSystem?: typeof recordSystemLog;
};

/** What the pass did, for the log line and for tests. */
export type MeetingClassificationResult = {
  outcome: MeetingOutcome;
  contactId: string | null;
  matchedOn: string | null;
  linkedDocument: boolean;
  wroteNote: boolean;
  stageOutcome: string | null;
  todosCreated: number;
  /** True when a prior classification stood and only the link was redone. */
  reusedPriorClassification: boolean;
};

/**
 * Run one guarded write, swallowing anything it throws.
 *
 * Every sink here is an independent side effect on an already-successful
 * import, so the failure of one says nothing about the others. Returns
 * whether it landed.
 */
async function attempt(
  label: string,
  businessId: string,
  fn: () => Promise<void>
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    logger.warn(`meeting classify: ${label} failed`, {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/**
 * The roster member a named action-item owner refers to, or null.
 *
 * Exact, case-insensitive, and UNIQUE, the same discipline as the speaker
 * name rule in resolve-contact: "Brian" assigns a to-do to Brian only when
 * exactly one Brian is on the roster. A first-name prefix match would be
 * friendlier and would silently hand work to the wrong person.
 */
export function matchRosterMember(
  members: Array<{ id: string; name: string; active: boolean }>,
  owner: string | null
): string | null {
  const needle = (owner ?? "").trim().toLowerCase();
  if (!needle) return null;
  const hits = members.filter(
    (m) => m.active && m.name.trim().toLowerCase() === needle
  );
  return hits.length === 1 ? hits[0].id : null;
}

async function fileActionItems(
  input: MeetingClassificationInput,
  contactId: string,
  actionItems: MeetingActionItem[],
  listMembers: NonNullable<ApplyMeetingOutcomeDeps["listMembers"]>,
  createTodoFn: NonNullable<ApplyMeetingOutcomeDeps["createTodoFn"]>
): Promise<number> {
  if (actionItems.length === 0) return 0;
  // One roster read for the whole batch, not one per item.
  let members: Array<{ id: string; name: string; active: boolean }> = [];
  try {
    members = await listMembers(input.businessId);
  } catch (err) {
    // An unreadable roster costs assignment, not the to-dos themselves.
    logger.warn("meeting classify: roster read failed; filing to-dos unassigned", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  let created = 0;
  for (const item of actionItems) {
    const assigneeEmployeeId = matchRosterMember(members, item.owner);
    const ok = await attempt("todo", input.businessId, async () => {
      await createTodoFn(
        input.businessId,
        {
          title: item.title,
          details: buildMeetingTodoDetails({
            documentTitle: input.documentTitle,
            owner: item.owner
          }),
          contactId,
          ...(assigneeEmployeeId ? { assigneeEmployeeId } : {})
        },
        // No auth user behind this: the platform filed it, not a person.
        null
      );
    });
    if (ok) created += 1;
  }
  return created;
}

/**
 * Classify a freshly imported meeting and apply the result.
 *
 * Never throws. Returns what it did so the caller can log it.
 */
export async function applyMeetingClassification(
  input: MeetingClassificationInput,
  deps: ApplyMeetingOutcomeDeps = {}
): Promise<MeetingClassificationResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const classify = deps.classify ?? classifyMeeting;
  const resolveContact = deps.resolveContact ?? resolveMeetingContact;
  const patchDocument = deps.patchDocument ?? patchBusinessDocument;
  const createNote = deps.createNote ?? createContactNote;
  const createTodoFn = deps.createTodoFn ?? createTodo;
  const listMembers = deps.listMembers ?? listTeamMembers;
  const fireStage = deps.fireStage ?? fireLifecycleStage;
  const stampLedger = deps.stampLedger ?? stampZoomTranscriptClassification;
  const readClassification = deps.readClassification ?? getZoomTranscriptClassification;
  const logSystem = deps.logSystem ?? recordSystemLog;
  /* c8 ignore stop */

  const result: MeetingClassificationResult = {
    outcome: MEETING_OUTCOME_UNCLEAR,
    contactId: null,
    matchedOn: null,
    linkedDocument: false,
    wroteNote: false,
    stageOutcome: null,
    todosCreated: 0,
    reusedPriorClassification: false
  };

  // A deliberate manual re-import of a meeting already decided about: file
  // the NEW document against the SAME contact and stop. No second model
  // call, no second note, no second set of to-dos, and no second stage move.
  const prior = await readClassification(input.businessId, input.meetingUuid);
  if (prior) {
    result.reusedPriorClassification = true;
    result.outcome = (prior.outcome ?? MEETING_OUTCOME_UNCLEAR) as MeetingOutcome;
    result.contactId = prior.contactId;
    if (prior.contactId) {
      const contactId = prior.contactId;
      result.linkedDocument = await attempt("document link", input.businessId, async () => {
        await patchDocument(input.businessId, input.documentId, { contact_id: contactId });
      });
    }
    await logReclassifySkipped(input, result, logSystem);
    return result;
  }

  const { outcome, actionItems } = await classify(input.businessId, input.minutes);
  result.outcome = outcome;

  // An unclear or internal meeting writes nothing to anybody's record. The
  // document already exists either way, which is the honest outcome when we
  // do not know what the call was.
  if (!outcomeTouchesContact(outcome) || outcome === MEETING_OUTCOME_UNCLEAR) {
    await stampResult(input, result, stampLedger, logSystem);
    return result;
  }

  const contact = await resolveContact({
    businessId: input.businessId,
    zoomMeetingId: input.zoomMeetingId,
    vtt: input.vtt,
    hostNames: input.hostNames
  });
  if (!contact) {
    await stampResult(input, result, stampLedger, logSystem);
    return result;
  }
  result.contactId = contact.contactId;
  result.matchedOn = contact.matchedOn;

  // 1. Link the document to the person it is about.
  result.linkedDocument = await attempt("document link", input.businessId, async () => {
    await patchDocument(input.businessId, input.documentId, {
      contact_id: contact.contactId
    });
  });

  // 2. The note.
  result.wroteNote = await attempt("note", input.businessId, async () => {
    await createNote({
      business_id: input.businessId,
      contact_id: contact.contactId,
      // No auth user: the label is what the contact page renders, and this
      // was not written by one of the tenant's people.
      author_user_id: null,
      author_label: MEETING_NOTE_AUTHOR_LABEL,
      body: buildMeetingNoteBody({
        outcome,
        documentTitle: input.documentTitle,
        summary: input.summary,
        actionItems
      })
    });
  });

  // 3. The stage move, through the platform's own machinery: the
  //    auto_lifecycle_stages kill switch, the stage-must-exist gate,
  //    forward-only, the tag cap and staff protection all apply here
  //    exactly as they do to a booking.
  const event = MEETING_OUTCOME_EVENT[outcome];
  if (event) {
    try {
      result.stageOutcome = await fireStage(input.businessId, contact.contactKey, event, {
        // Exactly-once per meeting instance, so a redelivery cannot
        // re-enqueue the tag_changed runs the move fires.
        dedupeSuffix: `zoom:${input.meetingUuid}`
      });
    } catch (err) {
      /* c8 ignore next 5 -- fireLifecycleStage owns its own try/catch */
      logger.warn("meeting classify: stage move failed", {
        businessId: input.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // 4. The action items.
  result.todosCreated = await fileActionItems(
    input,
    contact.contactId,
    actionItems,
    listMembers,
    createTodoFn
  );

  await stampResult(input, result, stampLedger, logSystem);
  return result;
}

/**
 * Stamp the ledger and log what happened.
 *
 * The stamp is what makes a deliberate manual re-import re-file the document
 * WITHOUT re-writing the note, the stage and the to-dos, so it is recorded
 * even for the outcomes that wrote nothing: "we already decided about this
 * meeting" is the fact being stored, not "we changed something".
 */
async function stampResult(
  input: MeetingClassificationInput,
  result: MeetingClassificationResult,
  stampLedger: NonNullable<ApplyMeetingOutcomeDeps["stampLedger"]>,
  logSystem: NonNullable<ApplyMeetingOutcomeDeps["logSystem"]>
): Promise<void> {
  await attempt("ledger stamp", input.businessId, async () => {
    await stampLedger(input.businessId, input.meetingUuid, {
      contactId: result.contactId,
      outcome: result.outcome
    });
  });
  await logSystem({
    businessId: input.businessId,
    source: MEETING_CLASSIFY_LOG_SOURCE,
    event: "meeting_classified",
    level: "info",
    message: `Meeting minutes classified as ${result.outcome}`,
    payload: {
      meetingUuid: input.meetingUuid,
      documentId: input.documentId,
      contactId: result.contactId,
      matchedOn: result.matchedOn,
      linkedDocument: result.linkedDocument,
      wroteNote: result.wroteNote,
      stageOutcome: result.stageOutcome,
      todosCreated: result.todosCreated
    }
  });
}

/** The re-import trail: says plainly that the earlier decision still stands. */
async function logReclassifySkipped(
  input: MeetingClassificationInput,
  result: MeetingClassificationResult,
  logSystem: NonNullable<ApplyMeetingOutcomeDeps["logSystem"]>
): Promise<void> {
  await logSystem({
    businessId: input.businessId,
    source: MEETING_CLASSIFY_LOG_SOURCE,
    event: "meeting_reclassify_skipped",
    level: "info",
    message:
      "Meeting re-imported; the existing classification stands and only the document link was refreshed",
    payload: {
      meetingUuid: input.meetingUuid,
      documentId: input.documentId,
      contactId: result.contactId,
      outcome: result.outcome,
      linkedDocument: result.linkedDocument
    }
  });
}

/**
 * Run the classification after the response flushes.
 *
 * `after()` rather than a bare floating promise for the same reason
 * `scheduleLongFormGraphExtract` uses it: on Vercel a fire-and-forget
 * promise is frozen the moment the response is sent, and this pass makes two
 * model calls. It throws outside a request scope (some tests and CLIs), and
 * the import result must not care.
 */
export function scheduleMeetingClassification(
  input: MeetingClassificationInput,
  deps: ApplyMeetingOutcomeDeps = {}
): void {
  try {
    after(() => applyMeetingClassification(input, deps));
  } catch (err) {
    logger.warn("meeting classify: scheduling failed (ignored)", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
