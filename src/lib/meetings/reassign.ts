/**
 * "This meeting was with somebody else": the correction.
 *
 * Zoom stamps every transcript line with the ACCOUNT's display name. A guest
 * who joins from a shared laptop, a partner's account, or an account still
 * carrying their legal name is recorded under a name that is not theirs, and
 * the import believes it: the document title, the retrieval summary, the
 * condensed minutes, the raw dialogue and the knowledge-graph person node
 * all inherit it, and contact attribution finds nobody because no contact
 * carries that name.
 *
 * Correcting that by hand means five edits in four places, two of which have
 * no owner-facing surface at all. This does all of it from one answer: WHO
 * the meeting was actually with.
 *
 *   1. Rename the guest through the title, the summary and the minutes
 *      (the raw dialogue lives under the minutes, so speaker labels are
 *      corrected by the same pass).
 *   2. Link the document to the right contact.
 *   3. Re-run the classification against the corrected minutes with the
 *      contact FORCED, so the note, the pipeline move and the to-dos land on
 *      the person instead of nowhere.
 *   4. Rename the knowledge-graph person node, keeping its edges: everything
 *      the graph learned about "Alexander" is true about Bobby, it was
 *      filed under the wrong name.
 *   5. Re-sync the box, which holds its own copy of both.
 *
 * Every step past the document write is INDEPENDENTLY guarded, the same
 * posture as `apply-outcome.ts`: a graph blip must not cost the rename the
 * owner asked for, and this function never throws.
 */
import { getBusinessDocument, patchBusinessDocument } from "@/lib/documents/db";
import { DOCUMENT_SUMMARY_MAX_CHARS } from "@/lib/documents/core";
import {
  listMemoryEntities,
  listActiveFactsForBusiness,
  updateMemoryEntity,
  updateMemoryFactSourceText,
  type MemoryEntityRow
} from "@/lib/memory/graph-db";
import {
  getZoomTranscriptImportByDocument,
  reopenZoomTranscriptClassification,
  type ReopenClassificationResult
} from "@/lib/db/zoom-transcript-imports";
import { fetchStoredTranscript } from "@/lib/zoom/stored-transcript";
import { resolveHostNames } from "@/lib/zoom/import-core";
import { getActiveZoomConnection } from "@/lib/db/zoom-connections";
import { getBusiness } from "@/lib/db/businesses";
import { recordSystemLog } from "@/lib/db/system-logs";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";
import { applyMeetingClassification } from "./apply-outcome";
import {
  deriveWrongGuestName,
  guestNameVariants,
  renameGuestInText
} from "./rename-guest";

/** Owner-facing activity trail, alongside the classify source. */
export const MEETING_REASSIGN_LOG_SOURCE = "zoom-meeting-reassign";

export type ReassignMeetingInput = {
  businessId: string;
  documentId: string;
  /** The contact the owner says the meeting was actually with. */
  contactId: string;
  /**
   * The name to rewrite, when the owner corrects one the derivation would
   * not have found (a nickname used only in the dialogue). Omitted means
   * "work it out from the title and the speaker labels".
   */
  wrongName?: string | null;
};

export type ReassignMeetingResult =
  | {
      ok: true;
      /** The name that was rewritten, or null when nothing needed renaming. */
      renamedFrom: string | null;
      renamedTo: string;
      title: string;
      /** Fields whose text actually changed. */
      rewrote: Array<"title" | "summary" | "content">;
      /** Whether the classification pass re-ran, and what it did. */
      reclassified: boolean;
      /**
       * True when a pass was already mid-flight on this meeting, so the
       * note, card and to-dos were deliberately left to it. The rename and
       * the link still happened; the owner can re-run in a minute.
       */
      reclassifyBlocked: boolean;
      outcome: string | null;
      wroteNote: boolean;
      todosCreated: number;
      stageOutcome: string | null;
      /** Graph nodes renamed (0 when the graph never learned this person). */
      graphEntitiesRenamed: number;
      graphFactsRewritten: number;
    }
  | {
      ok: false;
      error: "document_not_found" | "contact_not_found" | "contact_unnamed";
      detail: string;
    };

export type ReassignMeetingDeps = {
  getDocument?: typeof getBusinessDocument;
  patchDocument?: typeof patchBusinessDocument;
  getContactById?: (
    businessId: string,
    contactId: string
  ) => Promise<{ id: string; display_name: string | null; customer_e164: string } | null>;
  getLedgerRow?: typeof getZoomTranscriptImportByDocument;
  /** Names that count as "us"; injected in tests. */
  loadHostNames?: (businessId: string) => Promise<string[]>;
  reopenClassification?: typeof reopenZoomTranscriptClassification;
  fetchTranscript?: typeof fetchStoredTranscript;
  classifyAndApply?: typeof applyMeetingClassification;
  listEntities?: typeof listMemoryEntities;
  listFacts?: typeof listActiveFactsForBusiness;
  updateEntity?: typeof updateMemoryEntity;
  updateFactSourceText?: typeof updateMemoryFactSourceText;
  syncVault?: typeof syncVaultToVpsAndLog;
  logSystem?: typeof recordSystemLog;
};

/**
 * Run one guarded repair, swallowing anything it throws.
 *
 * Same rationale as `apply-outcome.ts`: each sink here is independent, and
 * the owner's document edit has already landed by the time these run.
 */
async function attempt<T>(
  label: string,
  businessId: string,
  fallback: T,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`meeting reassign: ${label} failed`, {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return fallback;
  }
}

export async function reassignMeetingContact(
  input: ReassignMeetingInput,
  deps: ReassignMeetingDeps = {}
): Promise<ReassignMeetingResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const getDocument = deps.getDocument ?? getBusinessDocument;
  const patchDocument = deps.patchDocument ?? patchBusinessDocument;
  const getContactById = deps.getContactById ?? getContactForReassign;
  const getLedgerRow = deps.getLedgerRow ?? getZoomTranscriptImportByDocument;
  const reopenClassification =
    deps.reopenClassification ?? reopenZoomTranscriptClassification;
  const fetchTranscript = deps.fetchTranscript ?? fetchStoredTranscript;
  const loadHostNames = deps.loadHostNames ?? loadMeetingHostNames;
  const classifyAndApply = deps.classifyAndApply ?? applyMeetingClassification;
  const syncVault = deps.syncVault ?? syncVaultToVpsAndLog;
  const logSystem = deps.logSystem ?? recordSystemLog;
  /* c8 ignore stop */
  const { businessId, documentId } = input;

  const document = await getDocument(businessId, documentId);
  if (!document) {
    return { ok: false, error: "document_not_found", detail: "Document not found" };
  }

  const contact = await getContactById(businessId, input.contactId);
  if (!contact) {
    return { ok: false, error: "contact_not_found", detail: "Contact not found" };
  }
  const rightName = (contact.display_name ?? "").trim();
  if (rightName === "") {
    // Renaming to an empty string would blank the guest out of the title and
    // the minutes, which is worse than the wrong name. Name them first.
    return {
      ok: false,
      error: "contact_unnamed",
      detail: "Give this contact a display name first, then reassign the meeting."
    };
  }

  const ledger = await attempt("ledger read", businessId, null, () =>
    getLedgerRow(businessId, documentId)
  );
  // The stored VTT is needed for the speaker labels the wrong name is
  // derived from. A meeting whose original file is gone still gets renamed
  // off the title alone.
  const vtt = ledger
    ? await attempt("transcript read", businessId, "", () =>
        fetchTranscript(businessId, document.storage_path)
      )
    : "";
  // Host names are not on the ledger row, and getting them wrong is not a
  // cosmetic error: the guest is "whoever is not us", so a missing host name
  // makes OUR speaker look like the guest and the rename would rewrite the
  // wrong side of the transcript. Same pair the import resolved.
  const hostNames = await attempt("host names", businessId, [] as string[], () =>
    loadHostNames(businessId)
  );

  const wrongName =
    (input.wrongName ?? "").trim() ||
    deriveWrongGuestName({ title: document.title, vtt, hostNames });

  const rename = (text: string): string =>
    wrongName ? renameGuestInText(text, wrongName, rightName, hostNames) : text;

  const nextTitle = rename(document.title);
  // The summary has a hard ceiling the documents API also enforces; a
  // longer replacement name must not push it past one and get the whole
  // correction rejected.
  const nextSummary = rename(document.summary ?? "").slice(0, DOCUMENT_SUMMARY_MAX_CHARS);
  const nextContent = rename(document.content_md ?? "");
  const rewrote: Array<"title" | "summary" | "content"> = [];
  if (nextTitle !== document.title) rewrote.push("title");
  if (nextSummary !== (document.summary ?? "")) rewrote.push("summary");
  if (nextContent !== (document.content_md ?? "")) rewrote.push("content");

  // The document write is the one step that is NOT guarded: if this fails
  // the owner's correction did not happen, and they must be told so rather
  // than shown a success that renamed nothing.
  await patchDocument(businessId, documentId, {
    title: nextTitle,
    summary: nextSummary,
    content_md: nextContent,
    contact_id: input.contactId,
    // A person's meeting record is internal by default, the same posture
    // linking a document through the documents API applies.
    audience: "staff"
  });

  const result: ReassignMeetingResult = {
    ok: true,
    renamedFrom: wrongName,
    renamedTo: rightName,
    title: nextTitle,
    rewrote,
    reclassified: false,
    reclassifyBlocked: false,
    outcome: null,
    wroteNote: false,
    todosCreated: 0,
    stageOutcome: null,
    graphEntitiesRenamed: 0,
    graphFactsRewritten: 0
  };

  // Re-run the classification with the contact forced. Only meetings the
  // import ledger knows about: without a meeting UUID there is no key to
  // claim, so a second run could not be told from the first and would file
  // the note twice.
  //
  // The reopen clears a stamp that is now provably about the wrong person,
  // but it refuses to clear a claim somebody is standing on, and THAT is a
  // gate: re-classifying alongside an in-flight pass lets the loser stamp
  // its own answer over this correction. `in_flight` is also what a ledger
  // blip answers, so the failure direction is "the owner re-runs the
  // reassign" rather than "somebody cleans up a duplicate note".
  if (ledger?.meeting_uuid) {
    const reopened = await attempt(
      "classification reopen",
      businessId,
      "in_flight" as ReopenClassificationResult,
      () => reopenClassification(businessId, ledger.meeting_uuid)
    );
    if (reopened === "in_flight") {
      result.reclassifyBlocked = true;
    } else {
      const applied = await classifyAndApply({
        businessId,
        documentId,
        documentTitle: nextTitle,
        content: nextContent,
        summary: nextSummary || null,
        vtt,
        meetingUuid: ledger.meeting_uuid,
        zoomMeetingId: null,
        hostNames,
        forcedContact: { contactId: contact.id, contactKey: contact.customer_e164 }
      });
      result.reclassified = !applied.reusedPriorClassification;
      result.outcome = applied.outcome;
      result.wroteNote = applied.wroteNote;
      result.todosCreated = applied.todosCreated;
      result.stageOutcome = applied.stageOutcome;
    }
  }

  if (wrongName) {
    const graph = await repairGraphGuestName(
      {
        businessId,
        wrongName,
        rightName,
        contactKey: contact.customer_e164,
        hostNames
      },
      deps
    );
    result.graphEntitiesRenamed = graph.entitiesRenamed;
    result.graphFactsRewritten = graph.factsRewritten;
  }

  // The box holds its own copy of the document digest and the graph notes,
  // so neither correction is live until it re-syncs.
  await attempt("vault sync", businessId, undefined, async () => {
    await syncVault(businessId);
  });

  await attempt("log", businessId, undefined, async () => {
    await logSystem({
      businessId,
      source: MEETING_REASSIGN_LOG_SOURCE,
      event: "meeting_reassigned",
      level: "info",
      message: wrongName
        ? `Meeting minutes reassigned from "${wrongName}" to ${rightName}`
        : `Meeting minutes reassigned to ${rightName}`,
      payload: {
        documentId,
        contactId: input.contactId,
        wrongName,
        rightName,
        rewrote,
        reclassified: result.reclassified,
        reclassifyBlocked: result.reclassifyBlocked,
        outcome: result.outcome,
        wroteNote: result.wroteNote,
        todosCreated: result.todosCreated,
        graphEntitiesRenamed: result.graphEntitiesRenamed,
        graphFactsRewritten: result.graphFactsRewritten
      }
    });
  });

  return result;
}

/**
 * Rename the guest's node in the knowledge graph, keeping its edges.
 *
 * A rename, not a deletion: "Alexander operates as a rental locator" is a
 * true fact that was filed under the wrong name, and deleting it would throw
 * away everything the meeting taught the coworker in order to fix a label.
 * The old name is kept as an alias so a later mention of it still resolves
 * to this person, and the contact key is stamped on so the node stops being
 * a floating stranger.
 *
 * Renames ONLY when exactly one person node answers to ANY form of the wrong
 * name, the same rule every other name-based match in this feature obeys:
 * two Alexanders means the graph is left alone and the owner is told nothing
 * was renamed.
 *
 * The quoted `source_text` is rewritten on the renamed node's own facts.
 * That is a deliberate scope: those are the statements the extractor made
 * ABOUT this person, and a mention of the old name inside some other
 * entity's provenance may well be a different Alexander.
 */
export async function repairGraphGuestName(
  input: {
    businessId: string;
    wrongName: string;
    rightName: string;
    contactKey: string;
    hostNames: string[];
  },
  deps: ReassignMeetingDeps = {}
): Promise<{ entitiesRenamed: number; factsRewritten: number }> {
  /* c8 ignore start -- production defaults; tests inject */
  const listEntities = deps.listEntities ?? listMemoryEntities;
  const listFacts = deps.listFacts ?? listActiveFactsForBusiness;
  const updateEntity = deps.updateEntity ?? updateMemoryEntity;
  const updateFactSourceText = deps.updateFactSourceText ?? updateMemoryFactSourceText;
  /* c8 ignore stop */
  const { businessId, wrongName, rightName } = input;
  const none = { entitiesRenamed: 0, factsRewritten: 0 };

  return attempt("graph rename", businessId, none, async () => {
    const entities = await listEntities(businessId);
    // Every form the document rewrite touches, not just the full Zoom label.
    // The extractor reads the MINUTES, which use the first name, so a Zoom
    // display name of "Alexander Delacroix" typically produced a node called
    // "Alexander": matching only the full string would correct the document
    // and leave the node wrong (Bugbot, PR #1618).
    const names = guestNameVariants(wrongName, input.hostNames);
    const matches = entities.filter((e) => names.some((name) => entityAnswersToName(e, name)));
    if (matches.length !== 1) {
      if (matches.length > 1) {
        logger.warn("meeting reassign: ambiguous graph node; left alone", {
          businessId,
          wrongName,
          matches: matches.length
        });
      }
      return none;
    }
    const entity = matches[0] as MemoryEntityRow;

    const aliases = [...entity.aliases];
    const oldAlias = wrongName.trim().toLowerCase();
    // The old name stays reachable: a later document still saying
    // "Alexander" must resolve to this node, not mint a second one.
    if (oldAlias !== rightName.trim().toLowerCase() && !aliases.includes(oldAlias)) {
      aliases.push(oldAlias);
    }
    await updateEntity(entity.id, {
      canonical_name: rightName,
      aliases,
      customer_e164: input.contactKey
    });

    const facts = await listFacts(businessId);
    let factsRewritten = 0;
    for (const fact of facts) {
      if (fact.subject_entity_id !== entity.id && fact.object_entity_id !== entity.id) continue;
      const rewritten = renameGuestInText(
        fact.source_text,
        wrongName,
        rightName,
        input.hostNames
      );
      if (rewritten === fact.source_text) continue;
      await updateFactSourceText(fact.id, rewritten);
      factsRewritten += 1;
    }
    return { entitiesRenamed: 1, factsRewritten };
  });
}

/**
 * Does this graph node go by the given name, as its name or an alias?
 *
 * `name` always comes from `guestNameVariants`, which yields trimmed,
 * non-empty tokens and nothing at all for an empty input, so there is no
 * blank case to guard here.
 */
function entityAnswersToName(entity: MemoryEntityRow, name: string): boolean {
  if (entity.kind !== "person") return false;
  const needle = name.trim().toLowerCase();
  if (entity.canonical_name.trim().toLowerCase() === needle) return true;
  return entity.aliases.some((alias) => alias.trim().toLowerCase() === needle);
}

/**
 * The names that counted as "us" on this import: the business name plus the
 * connected Zoom account's own display name, which is what the host
 * actually speaks under. Both reads are local, no Zoom API call.
 */
export async function loadMeetingHostNames(businessId: string): Promise<string[]> {
  const business = await getBusiness(businessId);
  return resolveHostNames(business?.name ?? "", () => getActiveZoomConnection(businessId));
}

/**
 * A contact row by id, the shape the rename needs.
 *
 * `contacts` is one of the residency tables deliberately KEPT central (the
 * box copy only ever lags the write ingress), so this reads central
 * directly rather than routing through `@/lib/residency/read`.
 */
export async function getContactForReassign(
  businessId: string,
  contactId: string
): Promise<{ id: string; display_name: string | null; customer_e164: string } | null> {
  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("contacts")
    .select("id, display_name, customer_e164")
    .eq("business_id", businessId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw new Error(`reassignMeetingContact(contact): ${error.message}`);
  return (data as { id: string; display_name: string | null; customer_e164: string } | null) ?? null;
}
