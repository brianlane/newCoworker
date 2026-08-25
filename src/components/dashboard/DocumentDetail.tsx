"use client";

/**
 * Per-document view/editor page body (Dashboard → Documents → document).
 *
 * Everything that used to live in DocumentsManager's expand-in-place panel:
 * rename / move-to-folder, audience, expiration + renewal dates, linked
 * contact and renewal handler, workflow record fields, the editable
 * agent-facing content (+ PowerPoint export), signature requests, and share
 * links, plus Open in browser (inline signed URL), Download, and Delete
 * (which navigates back to the list).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, ExternalLink, Download, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { DOCUMENT_SUMMARY_MAX_CHARS } from "@/lib/documents/core";
import { Button } from "@/components/ui/Button";
import {
  AUDIENCE_LABELS,
  contactLabel,
  documentFolder,
  expiryBadge,
  formatByteSize,
  inputClass,
  labelClass,
  openOriginalFile,
  renewalBadge,
  type ContactOption,
  type DocumentItem,
  type MemberOption
} from "@/components/dashboard/documents-shared";

type ShareItem = {
  id: string;
  shared_with: string;
  channel: string;
  expires_at: string;
  revoked_at: string | null;
  access_count: number;
  created_at: string;
};

/**
 * Is this a recorded meeting, and therefore correctable?
 *
 * The Zoom import files everything it produces in the `meeting` folder, so
 * that is the test. An owner who has since moved the document elsewhere has
 * told us it is not a meeting record any more, and the control goes away
 * with it.
 */
function isMeetingDocument(doc: DocumentItem): boolean {
  return doc.category.trim().toLowerCase() === "meeting";
}

/** What POST …/reassign reports back, for the confirmation line. */
type ReassignResult = {
  renamedFrom: string | null;
  renamedTo: string;
  rewrote: Array<"title" | "summary" | "content">;
  reclassified: boolean;
  outcome: string | null;
  wroteNote: boolean;
  todosCreated: number;
  graphEntitiesRenamed: number;
  graphFactsRewritten: number;
};

/**
 * Plain-English receipt for a reassign.
 *
 * The repair touches four places an owner cannot see, so the confirmation
 * names each one it actually changed rather than saying "done": a rename
 * that quietly matched nothing must not read the same as one that worked.
 */
function describeReassign(result: ReassignResult): string {
  const parts: string[] = [];
  if (result.renamedFrom && result.rewrote.length > 0) {
    parts.push(`renamed ${result.renamedFrom} to ${result.renamedTo} in the ${listWords(result.rewrote)}`);
  } else {
    parts.push(`linked to ${result.renamedTo}`);
  }
  if (result.wroteNote) parts.push("filed a note on their record");
  if (result.todosCreated > 0) {
    parts.push(`created ${result.todosCreated} to-do${result.todosCreated === 1 ? "" : "s"}`);
  }
  if (result.graphEntitiesRenamed > 0) parts.push("renamed what your coworker remembers");
  if (result.reclassified && !result.wroteNote && result.todosCreated === 0) {
    parts.push(`re-read the meeting (${result.outcome ?? "unclear"}), nothing else to file`);
  }
  return `Done: ${parts.join(", ")}.`;
}

/** "title and summary", "title, summary and content". */
function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

type SignatureRequestItem = {
  id: string;
  signer_name: string;
  signer_email: string;
  signer_phone: string;
  status: "sent" | "viewed" | "signed" | "void";
  signature_name: string | null;
  signed_at: string | null;
  expires_at: string;
  created_at: string;
};

export function DocumentDetail({
  businessId,
  initialDocument,
  implicitOwner = null
}: {
  businessId: string;
  initialDocument: DocumentItem;
  /**
   * Set when the roster is exactly one ACTIVE member who is provably the
   * business owner (the #1500 implicit-owner rule). Display-only: the
   * "Renewal handled by" picker opens on them and drops the "unassigned"
   * choice (it would resolve straight back to them). Nothing is written
   * until the owner actively picks, so hiring a second teammate restores
   * the unassigned state with no backfill.
   */
  implicitOwner?: { id: string; name: string } | null;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState<DocumentItem>(initialDocument);
  const [error, setError] = useState<string | null>(null);
  const [savingDoc, setSavingDoc] = useState(false);
  const [draftTitle, setDraftTitle] = useState(initialDocument.title);
  const [draftCategory, setDraftCategory] = useState(initialDocument.category);
  const [draftContent, setDraftContent] = useState(initialDocument.content_md);
  const [draftSummary, setDraftSummary] = useState(initialDocument.summary ?? "");
  const [reassignContactId, setReassignContactId] = useState("");
  const [reassigning, setReassigning] = useState(false);
  const [reassignNotice, setReassignNotice] = useState<string | null>(null);
  const [draftExpires, setDraftExpires] = useState(
    initialDocument.expires_at ? initialDocument.expires_at.slice(0, 10) : ""
  );
  const [draftRenewal, setDraftRenewal] = useState(
    initialDocument.renewal_date ? initialDocument.renewal_date.slice(0, 10) : ""
  );
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [signatureRequests, setSignatureRequests] = useState<SignatureRequestItem[]>([]);
  const [sigName, setSigName] = useState("");
  const [sigRecipient, setSigRecipient] = useState("");
  const [sigMessage, setSigMessage] = useState("");
  const [sigSending, setSigSending] = useState(false);

  /** Re-read the document after a save (keeps badges/folder chips honest). */
  const refreshDoc = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/documents/${doc.id}?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: { document?: DocumentItem } };
      if (json.ok && json.data?.document) {
        const fresh = json.data.document;
        setDoc(fresh);
        // A reassign rewrites all three of these server-side. Leaving the
        // drafts alone would show the old name in the editors and let the
        // next save put it straight back.
        setDraftTitle(fresh.title);
        setDraftSummary(fresh.summary ?? "");
        setDraftContent(fresh.content_md);
      }
    } catch {
      /* keep the current view */
    }
  }, [businessId, doc.id]);

  const refreshSignatureRequests = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/documents/${doc.id}/signature-requests?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as {
        ok: boolean;
        data?: { requests?: SignatureRequestItem[] };
      };
      if (json.ok && json.data?.requests) setSignatureRequests(json.data.requests);
    } catch {
      /* signatures panel stays empty */
    }
  }, [businessId, doc.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/documents/${doc.id}/shares?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as { ok: boolean; data?: { shares?: ShareItem[] } };
        if (!cancelled && json.ok && json.data?.shares) setShares(json.data.shares);
      } catch {
        /* shares panel stays empty */
      }
      await refreshSignatureRequests();
      try {
        // 200 is MAX_LIST_LIMIT on the customers API, a larger value fails
        // validation and would hide the picker entirely.
        const res = await fetch(
          `/api/dashboard/customers?businessId=${encodeURIComponent(businessId)}&limit=200`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: { customers?: ContactOption[] };
        };
        if (!cancelled && json.ok && json.data?.customers) setContacts(json.data.customers);
      } catch {
        /* contact picker stays hidden */
      }
      try {
        const res = await fetch(
          `/api/dashboard/employees?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as { ok: boolean; data?: { members?: MemberOption[] } };
        if (!cancelled && json.ok && json.data?.members) setMembers(json.data.members);
      } catch {
        /* assignee picker stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, doc.id, refreshSignatureRequests]);

  async function patchDocument(patch: Record<string, unknown>) {
    setSavingDoc(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/documents/${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, ...patch })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Save failed");
        return;
      }
      await refreshDoc();
    } catch {
      setError("Save failed, try again.");
    } finally {
      setSavingDoc(false);
    }
  }

  /**
   * "This meeting was with somebody else."
   *
   * Rewrites the guest's name through the document, links the contact,
   * re-runs the meeting classification against the corrected minutes and
   * renames the matching knowledge-graph node. Every draft is re-seeded from
   * the server afterwards, because all three of them just changed underneath
   * the editor.
   */
  async function reassignMeeting() {
    if (!reassignContactId) return;
    setReassigning(true);
    setError(null);
    setReassignNotice(null);
    try {
      const res = await fetch(`/api/dashboard/documents/${doc.id}/reassign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, contactId: reassignContactId })
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: { message?: string };
        data?: { reassign?: ReassignResult };
      };
      if (!json.ok || !json.data?.reassign) {
        setError(json.error?.message ?? "Could not reassign this meeting");
        return;
      }
      setReassignNotice(describeReassign(json.data.reassign));
      setReassignContactId("");
      await refreshDoc();
    } catch {
      setError("Could not reassign this meeting, try again.");
    } finally {
      setReassigning(false);
    }
  }

  async function removeDocument() {
    if (!window.confirm("Delete this document? The coworker stops using it and share links die.")) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/documents/${doc.id}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Delete failed");
        return;
      }
      router.push("/dashboard/documents");
    } catch {
      setError("Delete failed, try again.");
    }
  }

  async function requestSignature() {
    const recipient = sigRecipient.trim();
    if (!sigName.trim() || !recipient) {
      setError("Enter the signer's name and their phone (+1…) or email.");
      return;
    }
    const isEmail = recipient.includes("@");
    if (!isEmail && !/^\+[1-9]\d{6,14}$/.test(recipient)) {
      setError("Phone must be E.164 (e.g. +16025550147), or use an email address.");
      return;
    }
    setError(null);
    setSigSending(true);
    try {
      const res = await fetch(`/api/dashboard/documents/${doc.id}/signature-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          signerName: sigName.trim(),
          ...(isEmail ? { email: recipient } : { phone: recipient }),
          ...(sigMessage.trim() ? { message: sigMessage.trim() } : {})
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Could not send the signature request");
        return;
      }
      setSigName("");
      setSigRecipient("");
      setSigMessage("");
      await refreshSignatureRequests();
    } catch {
      setError("Could not send the signature request, try again.");
    } finally {
      setSigSending(false);
    }
  }

  async function voidSignatureRequest(requestId: string) {
    try {
      const res = await fetch(`/api/dashboard/documents/${doc.id}/signature-requests`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, requestId })
      });
      const json = (await res.json()) as { ok: boolean };
      if (json.ok) await refreshSignatureRequests();
    } catch {
      /* leave as-is */
    }
  }

  async function revokeShare(shareId: string) {
    try {
      const res = await fetch(`/api/dashboard/documents/${doc.id}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, shareId })
      });
      const json = (await res.json()) as { ok: boolean };
      if (json.ok) {
        setShares((prev) =>
          prev.map((s) => (s.id === shareId ? { ...s, revoked_at: new Date().toISOString() } : s))
        );
      }
    } catch {
      /* leave as-is */
    }
  }

  async function openFile(mode: "inline" | "attachment") {
    setError(null);
    const failure = await openOriginalFile(businessId, doc.id, mode);
    if (failure) setError(failure);
  }

  const badge = expiryBadge(doc);
  const renewal = renewalBadge(doc);
  const folder = documentFolder(doc);

  return (
    <div className="space-y-4">
      {/* Breadcrumb reads the LIVE document, so renames and folder moves
          update the trail immediately (a server-rendered one would go stale). */}
      <nav className="flex items-center gap-1 text-sm text-parchment/50" aria-label="Breadcrumb">
        <Link href="/dashboard/documents" className="hover:text-parchment">
          Documents
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-parchment/30" />
        <Link
          href={`/dashboard/documents?folder=${encodeURIComponent(folder)}`}
          className="hover:text-parchment"
        >
          {folder}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-parchment/30" />
        <span className="truncate text-parchment/80">{doc.title}</span>
      </nav>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-parchment break-words">{doc.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded border border-parchment/20 px-1.5 py-0.5 text-[11px] text-parchment/50">
                {documentFolder(doc)}
              </span>
              <span className="rounded border border-parchment/20 px-1.5 py-0.5 text-[11px] text-parchment/50">
                {AUDIENCE_LABELS[doc.audience]}
              </span>
              {doc.status !== "ready" && (
                <span
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${
                    doc.status === "failed"
                      ? "border-spark-orange/50 text-spark-orange"
                      : "border-parchment/20 text-parchment/50"
                  }`}
                >
                  {doc.status === "failed" ? "Ingest failed" : "Processing"}
                </span>
              )}
              {badge && (
                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${badge.tone}`}>
                  {badge.text}
                </span>
              )}
              {renewal && (
                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${renewal.tone}`}>
                  {renewal.text}
                </span>
              )}
              <span className="text-[11px] text-parchment/35">
                {formatByteSize(doc.byte_size)}
              </span>
            </div>
            {doc.summary ? <p className="mt-2 text-xs text-parchment/45">{doc.summary}</p> : null}
            {doc.status === "failed" && doc.error_detail ? (
              <p className="mt-1 text-xs text-spark-orange/80">
                Could not read this file ({doc.error_detail}). You can paste the content manually
                below.
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => void openFile("inline")}>
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open in browser
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void openFile("attachment")}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void removeDocument()}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5 text-spark-orange/80" />
              Delete
            </Button>
          </div>
        </div>
        {error ? (
          <p className="mt-3 text-xs text-spark-orange" role="alert">
            {error}
          </p>
        ) : null}
      </Card>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Title</label>
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                maxLength={200}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={savingDoc}
                disabled={!draftTitle.trim() || draftTitle.trim() === doc.title}
                onClick={() => void patchDocument({ title: draftTitle.trim() })}
              >
                Rename
              </Button>
            </div>
          </div>
          <div>
            <label className={labelClass}>Folder (category)</label>
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={draftCategory}
                onChange={(e) => setDraftCategory(e.target.value)}
                maxLength={100}
                placeholder="meeting / pricing / policies"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={savingDoc}
                disabled={!draftCategory.trim() || draftCategory.trim() === doc.category}
                onClick={() => void patchDocument({ category: draftCategory.trim() })}
              >
                Move
              </Button>
            </div>
          </div>
          <div>
            <label className={labelClass}>Audience</label>
            <select
              className={inputClass}
              value={doc.audience}
              onChange={(e) => void patchDocument({ audience: e.target.value })}
            >
              <option value="both">Customers + internal</option>
              <option value="clients">Customers</option>
              <option value="staff">Internal only</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Expires</label>
            <div className="flex gap-2">
              <input
                type="date"
                className={inputClass}
                value={draftExpires}
                onChange={(e) => setDraftExpires(e.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={savingDoc}
                onClick={() => void patchDocument({ expiresAt: draftExpires ? draftExpires : null })}
              >
                Set
              </Button>
            </div>
          </div>
          <div>
            <label className={labelClass}>
              Renewal date (reminds ahead, the document stays active)
            </label>
            <div className="flex gap-2">
              <input
                type="date"
                className={inputClass}
                value={draftRenewal}
                onChange={(e) => setDraftRenewal(e.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={savingDoc}
                onClick={() =>
                  void patchDocument({ renewalDate: draftRenewal ? draftRenewal : null })
                }
              >
                Set
              </Button>
            </div>
          </div>
          {contacts.length > 0 && (
            <div>
              <label className={labelClass}>Linked contact (policy holder)</label>
              <select
                className={inputClass}
                value={doc.contact_id ?? ""}
                onChange={(e) =>
                  void patchDocument({ contactId: e.target.value ? e.target.value : null })
                }
              >
                <option value="">not linked</option>
                {/* A linked contact beyond the 200-contact picker page keeps
                    its own option so the select never misreports the doc as
                    unlinked. */}
                {doc.contact_id && !contacts.some((c) => c.id === doc.contact_id) && (
                  <option value={doc.contact_id}>Linked contact (kept)</option>
                )}
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {contactLabel(c)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {doc.record_fields && Object.keys(doc.record_fields).length > 0 && (
            <div>
              <label className={labelClass}>Record fields (captured by your workflows)</label>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(doc.record_fields).map(([key, value]) => (
                  <span
                    key={key}
                    className="rounded border border-parchment/20 px-1.5 py-0.5 text-[11px] text-parchment/60"
                  >
                    <span className="text-parchment/40">{key}:</span> {value}
                  </span>
                ))}
              </div>
            </div>
          )}
          {members.length > 0 && (
            <div>
              <label className={labelClass}>Renewal handled by</label>
              <select
                className={inputClass}
                value={doc.assigned_employee_id ?? implicitOwner?.id ?? ""}
                onChange={(e) =>
                  void patchDocument({
                    assignedEmployeeId: e.target.value ? e.target.value : null
                  })
                }
              >
                {!implicitOwner && <option value="">unassigned</option>}
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {implicitOwner && !doc.assigned_employee_id && (
                <p className="mt-1 text-xs text-parchment/40">
                  Your team is just you, so renewals land with you until you add a teammate.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="mt-4">
          <label className={labelClass}>
            One-line summary (what your coworker quotes when it cites this document)
          </label>
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={draftSummary}
              onChange={(e) => setDraftSummary(e.target.value)}
              maxLength={DOCUMENT_SUMMARY_MAX_CHARS}
              placeholder="A sentence saying what this document is."
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={savingDoc}
              disabled={draftSummary === (doc.summary ?? "")}
              onClick={() => void patchDocument({ summary: draftSummary })}
            >
              Save
            </Button>
          </div>
        </div>

        <div className="mt-4">
          <label className={labelClass}>What the coworker knows from this document (editable)</label>
          <textarea
            className={`${inputClass} min-h-40 font-mono text-xs`}
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={savingDoc}
              onClick={() => void patchDocument({ contentMd: draftContent })}
            >
              Save content
            </Button>
            {/* The export builds from SAVED, ready content, the route rejects
                processing/failed/empty docs, and with unsaved edits the link
                would silently ship an older deck, so both gate the control. */}
            {doc.status === "ready" && (doc.content_md ?? "").trim().length > 0 ? (
              draftContent === (doc.content_md ?? "") ? (
                <a
                  href={`/api/dashboard/documents/${doc.id}/pptx?businessId=${encodeURIComponent(businessId)}`}
                  className="inline-flex items-center rounded-md border border-parchment/20 px-3 py-1.5 text-xs text-parchment hover:bg-parchment/10 transition-colors"
                  title="Headings become slides, bullets become bullets"
                >
                  Download as PowerPoint
                </a>
              ) : (
                <span
                  className="inline-flex items-center rounded-md border border-parchment/10 px-3 py-1.5 text-xs text-parchment/40 cursor-not-allowed"
                  title="Save your content edits first, the export uses saved content"
                >
                  Download as PowerPoint (save first)
                </span>
              )
            ) : null}
          </div>
        </div>
      </Card>

      {isMeetingDocument(doc) && contacts.length > 0 && (
        <Card>
          <label className={labelClass}>Was this meeting with someone else?</label>
          <p className="mt-1 text-xs text-parchment/50">
            Zoom labels a recording with the account name, so a guest who joined from someone
            else&apos;s account is filed under the wrong name. Pick who was actually on the call and
            your coworker fixes the name everywhere it landed: the title, the summary, the minutes,
            the transcript, and what it remembers about them.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <select
              className={`${inputClass} sm:max-w-xs`}
              value={reassignContactId}
              onChange={(e) => setReassignContactId(e.target.value)}
            >
              <option value="">pick the contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {contactLabel(c)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={reassigning}
              disabled={!reassignContactId}
              onClick={() => void reassignMeeting()}
            >
              Reassign meeting
            </Button>
          </div>
          {reassignNotice ? (
            <p className="mt-2 text-xs text-claw-green" role="status">
              {reassignNotice}
            </p>
          ) : null}
        </Card>
      )}

      <Card>
        <label className={labelClass}>Signatures</label>
        {signatureRequests.length === 0 ? (
          <p className="text-xs text-parchment/40">
            No signature requests yet. Send one below for a legal sign-off.
          </p>
        ) : (
          <ul className="space-y-1">
            {signatureRequests.map((r) => {
              const dead =
                r.status === "void" ||
                (r.status !== "signed" && Date.parse(r.expires_at) <= Date.now());
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-2 text-xs text-parchment/60"
                >
                  <span className="text-parchment/80">{r.signer_name}</span>
                  <span className="text-parchment/35">{r.signer_phone || r.signer_email}</span>
                  {r.status === "signed" ? (
                    <span className="rounded border border-signal-teal/50 px-1.5 py-0.5 text-signal-teal">
                      Signed {r.signed_at?.slice(0, 10)} as {r.signature_name}
                    </span>
                  ) : dead ? (
                    <span className="text-parchment/35">
                      {r.status === "void" ? "voided" : "expired"}
                    </span>
                  ) : (
                    <>
                      <span className="rounded border border-parchment/20 px-1.5 py-0.5">
                        {r.status === "viewed" ? "Viewed" : "Sent"}
                      </span>
                      <button
                        type="button"
                        onClick={() => void voidSignatureRequest(r.id)}
                        className="text-spark-orange/80 hover:text-spark-orange"
                      >
                        Void
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <input
            className={inputClass}
            value={sigName}
            onChange={(e) => setSigName(e.target.value)}
            placeholder="Signer's name"
          />
          <input
            className={inputClass}
            value={sigRecipient}
            onChange={(e) => setSigRecipient(e.target.value)}
            placeholder="+16025550147 or email"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={sigSending}
            onClick={() => void requestSignature()}
          >
            Request signature
          </Button>
          <input
            className={`${inputClass} sm:col-span-3`}
            value={sigMessage}
            onChange={(e) => setSigMessage(e.target.value)}
            placeholder="Optional note shown above the document"
          />
        </div>
      </Card>

      <Card>
        <label className={labelClass}>Share links</label>
        {shares.length === 0 ? (
          <p className="text-xs text-parchment/40">
            No links yet. Ask your coworker to share this document, or use it in an AiFlow.
          </p>
        ) : (
          <ul className="space-y-1">
            {shares.map((s) => {
              const dead = Boolean(s.revoked_at) || Date.parse(s.expires_at) <= Date.now();
              return (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-2 text-xs text-parchment/60"
                >
                  <span>{s.shared_with || "(link)"}</span>
                  <span className="text-parchment/35">via {s.channel}</span>
                  <span className="text-parchment/35">opened {s.access_count}×</span>
                  {dead ? (
                    <span className="text-parchment/35">
                      {s.revoked_at ? "revoked" : "expired"}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void revokeShare(s.id)}
                      className="text-spark-orange/80 hover:text-spark-orange"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
