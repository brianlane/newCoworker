"use client";

/**
 * Business Documents manager (Dashboard → Memory → Documents).
 *
 * Upload real business documents (price sheets, policies, contracts, SOPs) that
 * every coworker surface answers from and shares on request. Each document
 * carries an audience (clients / staff / both), an optional expiration date
 * (expired docs go inert to the agent and the daily sweep reminds the
 * owner), an editable agent-facing markdown body, and a list of active
 * share links with one-click revoke.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type DocumentItem = {
  id: string;
  title: string;
  category: string;
  audience: "clients" | "staff" | "both";
  mime_type: string;
  byte_size: number;
  content_md: string;
  summary: string;
  status: "processing" | "ready" | "failed";
  error_detail: string | null;
  expires_at: string | null;
  contact_id: string | null;
  renewal_date: string | null;
  assigned_employee_id: string | null;
  created_at: string;
};

type ContactOption = { id: string; customerE164: string; displayName: string | null };

type MemberOption = { id: string; name: string };

type ShareItem = {
  id: string;
  shared_with: string;
  channel: string;
  expires_at: string;
  revoked_at: string | null;
  access_count: number;
  created_at: string;
};

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

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

const AUDIENCE_LABELS: Record<DocumentItem["audience"], string> = {
  clients: "Customers",
  staff: "Internal only",
  both: "Customers + internal"
};

function expiryBadge(doc: DocumentItem): { text: string; tone: string } | null {
  if (!doc.expires_at) return null;
  const ms = Date.parse(doc.expires_at);
  if (!Number.isFinite(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days <= 0) return { text: "Expired", tone: "text-spark-orange border-spark-orange/50" };
  if (days <= 7) {
    return { text: `Expires in ${days}d`, tone: "text-spark-orange border-spark-orange/40" };
  }
  return {
    text: `Expires ${doc.expires_at.slice(0, 10)}`,
    tone: "text-parchment/50 border-parchment/20"
  };
}

function renewalBadge(doc: DocumentItem): { text: string; tone: string } | null {
  if (!doc.renewal_date) return null;
  const ms = Date.parse(doc.renewal_date);
  if (!Number.isFinite(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days <= 0) return { text: "Renewal overdue", tone: "text-spark-orange border-spark-orange/50" };
  if (days <= 30) {
    return { text: `Renews in ${days}d`, tone: "text-spark-orange border-spark-orange/40" };
  }
  return {
    text: `Renews ${doc.renewal_date.slice(0, 10)}`,
    tone: "text-parchment/50 border-parchment/20"
  };
}

export function DocumentsManager({ businessId }: { businessId: string }) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadAudience, setUploadAudience] = useState<DocumentItem["audience"]>("both");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadCategory, setUploadCategory] = useState("");
  const [uploadExpires, setUploadExpires] = useState("");
  const [uploadRenewal, setUploadRenewal] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Per-document expanded panel state. The ref mirrors openId so async
  // fetches can verify the SAME document is still expanded before applying
  // results — a slow response must never show another document's signer or
  // share PII under the wrong panel.
  const [openId, setOpenId] = useState<string | null>(null);
  const openIdRef = useRef<string | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [draftExpires, setDraftExpires] = useState("");
  const [draftRenewal, setDraftRenewal] = useState("");
  const [savingDoc, setSavingDoc] = useState(false);
  // Pickers for linking a document to a contact / assigning a renewal
  // handler. Loaded once on mount; both selects degrade to hidden when the
  // directory fetch fails or comes back empty.
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [shares, setShares] = useState<ShareItem[]>([]);
  // Signature requests for the open document + the request form.
  const [signatureRequests, setSignatureRequests] = useState<SignatureRequestItem[]>([]);
  const [sigName, setSigName] = useState("");
  const [sigRecipient, setSigRecipient] = useState("");
  const [sigMessage, setSigMessage] = useState("");
  const [sigSending, setSigSending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/documents?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: { documents?: DocumentItem[] } };
      if (json.ok && json.data?.documents) setDocuments(json.data.documents);
    } catch {
      /* keep the last list */
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 200 is MAX_LIST_LIMIT on the customers API — a larger value fails
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
  }, [businessId]);

  function contactLabel(option: ContactOption): string {
    return option.displayName?.trim()
      ? `${option.displayName} (${option.customerE164})`
      : option.customerE164;
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Pick a file first (PDF, text, markdown, or CSV).");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.set("businessId", businessId);
      form.set("file", file);
      if (uploadTitle.trim()) form.set("title", uploadTitle.trim());
      if (uploadCategory.trim()) form.set("category", uploadCategory.trim());
      form.set("audience", uploadAudience);
      if (uploadExpires) form.set("expiresAt", uploadExpires);
      if (uploadRenewal) form.set("renewalDate", uploadRenewal);
      const res = await fetch("/api/dashboard/documents", { method: "POST", body: form });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Upload failed");
        return;
      }
      setUploadTitle("");
      setUploadCategory("");
      setUploadExpires("");
      setUploadRenewal("");
      if (fileRef.current) fileRef.current.value = "";
      await refresh();
    } catch {
      setError("Upload failed — try again.");
    } finally {
      setUploading(false);
    }
  }

  async function openDocument(doc: DocumentItem) {
    if (openId === doc.id) {
      setOpenId(null);
      openIdRef.current = null;
      return;
    }
    setOpenId(doc.id);
    openIdRef.current = doc.id;
    setDraftContent(doc.content_md);
    setDraftExpires(doc.expires_at ? doc.expires_at.slice(0, 10) : "");
    setDraftRenewal(doc.renewal_date ? doc.renewal_date.slice(0, 10) : "");
    setShares([]);
    setSignatureRequests([]);
    setSigName("");
    setSigRecipient("");
    setSigMessage("");
    try {
      const res = await fetch(
        `/api/dashboard/documents/${doc.id}/shares?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: { shares?: ShareItem[] } };
      // Only apply if this document is STILL the expanded one (see openIdRef).
      if (openIdRef.current === doc.id && json.ok && json.data?.shares) {
        setShares(json.data.shares);
      }
    } catch {
      /* shares panel stays empty */
    }
    await refreshSignatureRequests(doc.id);
  }

  async function refreshSignatureRequests(docId: string) {
    try {
      const res = await fetch(
        `/api/dashboard/documents/${docId}/signature-requests?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as {
        ok: boolean;
        data?: { requests?: SignatureRequestItem[] };
      };
      // Only apply if this document is STILL the expanded one — a slow
      // response must not render another document's signers.
      if (openIdRef.current === docId && json.ok && json.data?.requests) {
        setSignatureRequests(json.data.requests);
      }
    } catch {
      /* signatures panel stays empty */
    }
  }

  async function requestSignature(docId: string) {
    const recipient = sigRecipient.trim();
    if (!sigName.trim() || !recipient) {
      setError("Enter the signer's name and their phone (+1…) or email.");
      return;
    }
    const isEmail = recipient.includes("@");
    if (!isEmail && !/^\+[1-9]\d{6,14}$/.test(recipient)) {
      setError("Phone must be E.164 (e.g. +16025550147) — or use an email address.");
      return;
    }
    setError(null);
    setSigSending(true);
    try {
      const res = await fetch(`/api/dashboard/documents/${docId}/signature-requests`, {
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
      await refreshSignatureRequests(docId);
    } catch {
      setError("Could not send the signature request — try again.");
    } finally {
      setSigSending(false);
    }
  }

  async function voidSignatureRequest(docId: string, requestId: string) {
    try {
      const res = await fetch(`/api/dashboard/documents/${docId}/signature-requests`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, requestId })
      });
      const json = (await res.json()) as { ok: boolean };
      if (json.ok) await refreshSignatureRequests(docId);
    } catch {
      /* leave as-is */
    }
  }

  async function patchDocument(docId: string, patch: Record<string, unknown>) {
    setSavingDoc(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, ...patch })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Save failed");
        return;
      }
      await refresh();
    } catch {
      setError("Save failed — try again.");
    } finally {
      setSavingDoc(false);
    }
  }

  async function removeDocument(docId: string) {
    if (!window.confirm("Delete this document? The coworker stops using it and share links die.")) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/documents/${docId}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Delete failed");
        return;
      }
      if (openId === docId) setOpenId(null);
      await refresh();
    } catch {
      setError("Delete failed — try again.");
    }
  }

  async function revokeShare(docId: string, shareId: string) {
    try {
      const res = await fetch(`/api/dashboard/documents/${docId}/shares`, {
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

  return (
    <Card>
      <h2 className="text-lg font-semibold text-parchment">Documents</h2>
      <p className="mt-1 text-sm text-parchment/50">
        Upload price sheets, policies, contracts, or internal SOPs. Your coworker answers questions
        from them and can text/email customers an expiring link on request. Internal-only
        documents never reach customers, and expired documents stop being quoted or shared
        automatically.
      </p>

      {/* ── Upload ─────────────────────────────────────────────────────── */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass}>
            File (PDF, text, markdown, CSV, or a meeting transcript .vtt — max 10 MB)
          </label>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md,.csv,.vtt,application/pdf,text/plain,text/markdown,text/csv,text/vtt"
            className="block w-full text-sm text-parchment/70 file:mr-3 file:rounded-md file:border-0 file:bg-signal-teal/20 file:px-3 file:py-1.5 file:text-sm file:text-signal-teal"
          />
        </div>
        <div>
          <label className={labelClass}>Title (optional — defaults to the file name)</label>
          <input
            className={inputClass}
            value={uploadTitle}
            onChange={(e) => setUploadTitle(e.target.value)}
            placeholder="Summer price list"
          />
        </div>
        <div>
          <label className={labelClass}>Category (optional)</label>
          <input
            className={inputClass}
            value={uploadCategory}
            onChange={(e) => setUploadCategory(e.target.value)}
            placeholder="pricing / policies / contracts"
          />
        </div>
        <div>
          <label className={labelClass}>Who can the coworker use it with?</label>
          <select
            className={inputClass}
            value={uploadAudience}
            onChange={(e) => setUploadAudience(e.target.value as DocumentItem["audience"])}
          >
            <option value="both">Customers + internal</option>
            <option value="clients">Customers</option>
            <option value="staff">Internal only (never shown to customers)</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Expires (optional)</label>
          <input
            type="date"
            className={inputClass}
            value={uploadExpires}
            onChange={(e) => setUploadExpires(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Renewal date (optional — reminds ahead)</label>
          <input
            type="date"
            className={inputClass}
            value={uploadRenewal}
            onChange={(e) => setUploadRenewal(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="button" variant="primary" size="sm" onClick={upload} loading={uploading}>
            Upload document
          </Button>
        </div>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-spark-orange" role="alert">
          {error}
        </p>
      ) : null}

      {/* ── List ───────────────────────────────────────────────────────── */}
      <div className="mt-5 space-y-2">
        {loading ? (
          <p className="text-sm text-parchment/40">Loading documents…</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-parchment/40">No documents yet.</p>
        ) : (
          documents.map((doc) => {
            const badge = expiryBadge(doc);
            const renewal = renewalBadge(doc);
            const linkedContact = doc.contact_id
              ? contacts.find((c) => c.id === doc.contact_id)
              : undefined;
            const open = openId === doc.id;
            return (
              <div key={doc.id} className="rounded-md border border-parchment/10 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void openDocument(doc)}
                    className="text-sm font-medium text-parchment hover:text-signal-teal"
                  >
                    {doc.title}
                  </button>
                  <span className="rounded border border-parchment/20 px-1.5 py-0.5 text-[11px] text-parchment/50">
                    {doc.category}
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
                  {doc.contact_id && (
                    <span className="rounded border border-signal-teal/40 px-1.5 py-0.5 text-[11px] text-signal-teal/90">
                      {/* The picker list is capped at the API's 200-contact page;
                          a linked contact beyond it still shows as linked. */}
                      {linkedContact ? contactLabel(linkedContact) : "Linked contact"}
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-parchment/35">
                    {(doc.byte_size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeDocument(doc.id)}
                    className="text-[11px] text-spark-orange/80 hover:text-spark-orange"
                  >
                    Delete
                  </button>
                </div>
                {doc.summary && !open ? (
                  <p className="mt-1 text-xs text-parchment/45">{doc.summary}</p>
                ) : null}
                {doc.status === "failed" && doc.error_detail ? (
                  <p className="mt-1 text-xs text-spark-orange/80">
                    Could not read this file ({doc.error_detail}). You can paste the content
                    manually below.
                  </p>
                ) : null}

                {open && (
                  <div className="mt-3 space-y-3 border-t border-parchment/10 pt-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className={labelClass}>Audience</label>
                        <select
                          className={inputClass}
                          value={doc.audience}
                          onChange={(e) => void patchDocument(doc.id, { audience: e.target.value })}
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
                            onClick={() =>
                              void patchDocument(doc.id, {
                                expiresAt: draftExpires ? draftExpires : null
                              })
                            }
                          >
                            Set
                          </Button>
                        </div>
                      </div>
                      <div>
                        <label className={labelClass}>
                          Renewal date (reminds ahead — the document stays active)
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
                              void patchDocument(doc.id, {
                                renewalDate: draftRenewal ? draftRenewal : null
                              })
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
                              void patchDocument(doc.id, {
                                contactId: e.target.value ? e.target.value : null
                              })
                            }
                          >
                            <option value="">— not linked —</option>
                            {/* A linked contact beyond the 200-contact picker
                                page keeps its own option so the select never
                                misreports the doc as unlinked. */}
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
                      {members.length > 0 && (
                        <div>
                          <label className={labelClass}>Renewal handled by</label>
                          <select
                            className={inputClass}
                            value={doc.assigned_employee_id ?? ""}
                            onChange={(e) =>
                              void patchDocument(doc.id, {
                                assignedEmployeeId: e.target.value ? e.target.value : null
                              })
                            }
                          >
                            <option value="">— unassigned —</option>
                            {members.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                    <div>
                      <label className={labelClass}>
                        What the coworker knows from this document (editable)
                      </label>
                      <textarea
                        className={`${inputClass} min-h-40 font-mono text-xs`}
                        value={draftContent}
                        onChange={(e) => setDraftContent(e.target.value)}
                      />
                      <div className="mt-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          loading={savingDoc}
                          onClick={() => void patchDocument(doc.id, { contentMd: draftContent })}
                        >
                          Save content
                        </Button>
                      </div>
                    </div>
                    <div>
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
                                <span className="text-parchment/35">
                                  {r.signer_phone || r.signer_email}
                                </span>
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
                                      onClick={() => void voidSignatureRequest(doc.id, r.id)}
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
                          onClick={() => void requestSignature(doc.id)}
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
                    </div>
                    <div>
                      <label className={labelClass}>Share links</label>
                      {shares.length === 0 ? (
                        <p className="text-xs text-parchment/40">
                          No links yet. Ask your coworker to share this document, or use it in an
                          AiFlow.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {shares.map((s) => {
                            const dead =
                              Boolean(s.revoked_at) || Date.parse(s.expires_at) <= Date.now();
                            return (
                              <li
                                key={s.id}
                                className="flex flex-wrap items-center gap-2 text-xs text-parchment/60"
                              >
                                <span>{s.shared_with || "(link)"}</span>
                                <span className="text-parchment/35">via {s.channel}</span>
                                <span className="text-parchment/35">
                                  opened {s.access_count}×
                                </span>
                                {dead ? (
                                  <span className="text-parchment/35">
                                    {s.revoked_at ? "revoked" : "expired"}
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => void revokeShare(doc.id, s.id)}
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
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
