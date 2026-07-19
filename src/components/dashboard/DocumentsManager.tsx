"use client";

/**
 * Business Documents — Drive-style file manager (Dashboard → Documents).
 *
 * Categories act as FOLDERS you navigate into (?folder=<category>, linkable
 * and back-button friendly), not collapsible sections: the root shows folder
 * tiles, a folder shows its files as cards (grid) or table rows (list view —
 * toggle persisted per browser). Each file carries a kebab menu (Open, Open
 * in browser, Download, Rename, Move to folder, Delete); clicking the card
 * itself opens the document's own page (/dashboard/documents/<id>) where the
 * full editor lives (DocumentDetail). Upload opens a modal, pre-filled with
 * the current folder. Search spans every folder; Zoom transcript imports
 * file themselves under `meeting` automatically.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Captions,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderInput,
  LayoutGrid,
  List,
  MoreVertical,
  Pencil,
  Trash2,
  Upload,
  X,
  type LucideIcon
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  AUDIENCE_LABELS,
  documentFolder,
  expiryBadge,
  formatByteSize,
  inputClass,
  labelClass,
  openOriginalFile,
  renewalBadge,
  type DocumentItem
} from "@/components/dashboard/documents-shared";

const VIEW_MODE_KEY = "documents-view-mode";

function mimeIcon(mime: string): LucideIcon {
  if (mime === "application/pdf") return File;
  if (mime === "text/vtt") return Captions;
  if (mime === "text/csv") return FileSpreadsheet;
  return FileText;
}

/** One badge row shared by grid cards and table rows. */
function StatusBadges({ doc }: { doc: DocumentItem }) {
  const badge = expiryBadge(doc);
  const renewal = renewalBadge(doc);
  return (
    <>
      {doc.status !== "ready" && (
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] ${
            doc.status === "failed"
              ? "border-spark-orange/50 text-spark-orange"
              : "border-parchment/20 text-parchment/50"
          }`}
        >
          {doc.status === "failed" ? "Ingest failed" : "Processing"}
        </span>
      )}
      {badge && (
        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${badge.tone}`}>
          {badge.text}
        </span>
      )}
      {renewal && (
        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${renewal.tone}`}>
          {renewal.text}
        </span>
      )}
    </>
  );
}

/** Minimal centered modal (the repo has no shared dialog component). */
function Modal({
  title,
  onClose,
  children
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-parchment/15 bg-deep-ink p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-parchment">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-parchment/50 hover:text-parchment"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function DocumentsManager({
  businessId,
  folder
}: {
  businessId: string;
  /** Current folder from the page's ?folder= search param; null = root. */
  folder: string | null;
}) {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [audienceFilter, setAudienceFilter] = useState<"all" | DocumentItem["audience"]>("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  // Kebab menu: id of the document whose menu is open.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Small modals driving the existing PATCH route.
  const [renameTarget, setRenameTarget] = useState<DocumentItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<DocumentItem | null>(null);
  const [modalValue, setModalValue] = useState("");
  const [modalSaving, setModalSaving] = useState(false);
  // Upload modal state.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadAudience, setUploadAudience] = useState<DocumentItem["audience"]>("both");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadCategory, setUploadCategory] = useState("");
  const [uploadExpires, setUploadExpires] = useState("");
  const [uploadRenewal, setUploadRenewal] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // View-mode preference survives reloads (read after mount so SSR and the
  // first client render agree).
  useEffect(() => {
    const stored = window.localStorage.getItem(VIEW_MODE_KEY);
    if (stored === "list" || stored === "grid") setView(stored);
  }, []);
  function switchView(next: "grid" | "list") {
    setView(next);
    window.localStorage.setItem(VIEW_MODE_KEY, next);
  }

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

  // Any click outside a kebab closes it (each menu stops propagation).
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuFor]);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Pick a file first (PDF, text, markdown, CSV, or .vtt).");
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
      setUploadOpen(false);
      await refresh();
    } catch {
      setError("Upload failed — try again.");
    } finally {
      setUploading(false);
    }
  }

  async function patchDocument(docId: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/dashboard/documents/${docId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, ...patch })
    });
    const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
    if (!json.ok) throw new Error(json.error?.message ?? "Save failed");
    await refresh();
  }

  async function submitModal() {
    const target = renameTarget ?? moveTarget;
    const value = modalValue.trim();
    if (!target || !value) return;
    setModalSaving(true);
    setError(null);
    try {
      await patchDocument(target.id, renameTarget ? { title: value } : { category: value });
      setRenameTarget(null);
      setMoveTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed — try again.");
    } finally {
      setModalSaving(false);
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
      await refresh();
    } catch {
      setError("Delete failed — try again.");
    }
  }

  async function openFile(docId: string, mode: "inline" | "attachment") {
    setError(null);
    const failure = await openOriginalFile(businessId, docId, mode);
    if (failure) setError(failure);
  }

  function goToFolder(category: string | null) {
    router.push(
      category
        ? `/dashboard/documents?folder=${encodeURIComponent(category)}`
        : "/dashboard/documents"
    );
  }

  // ── Derived views ────────────────────────────────────────────────────
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const filtered = documents.filter(
    (doc) =>
      (audienceFilter === "all" || doc.audience === audienceFilter) &&
      (!searching ||
        doc.title.toLowerCase().includes(query) ||
        doc.summary.toLowerCase().includes(query) ||
        doc.category.toLowerCase().includes(query))
  );
  const folders = new Map<string, DocumentItem[]>();
  for (const doc of filtered) {
    const key = documentFolder(doc);
    const list = folders.get(key);
    if (list) list.push(doc);
    else folders.set(key, [doc]);
  }
  const folderTiles = [...folders.entries()].sort(([a], [b]) => a.localeCompare(b));
  // Searching shows a flat, cross-folder result set; otherwise the current
  // folder's files (root shows tiles only).
  const visibleDocs = searching
    ? filtered
    : folder
      ? (folders.get(folder) ?? [])
      : [];

  function kebab(doc: DocumentItem) {
    const open = menuFor === doc.id;
    return (
      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          aria-label={`Actions for ${doc.title}`}
          aria-expanded={open}
          onClick={() => setMenuFor(open ? null : doc.id)}
          className="rounded p-1 text-parchment/50 hover:bg-parchment/10 hover:text-parchment"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {open && (
          <div className="absolute right-0 z-40 mt-1 w-44 rounded-lg border border-parchment/15 bg-deep-ink py-1 shadow-xl">
            {(
              [
                {
                  label: "Open",
                  icon: FileText,
                  act: () => router.push(`/dashboard/documents/${doc.id}`)
                },
                {
                  label: "Open in browser",
                  icon: ExternalLink,
                  act: () => void openFile(doc.id, "inline")
                },
                {
                  label: "Download",
                  icon: Download,
                  act: () => void openFile(doc.id, "attachment")
                },
                {
                  label: "Rename",
                  icon: Pencil,
                  act: () => {
                    setModalValue(doc.title);
                    setRenameTarget(doc);
                  }
                },
                {
                  label: "Move to folder",
                  icon: FolderInput,
                  act: () => {
                    setModalValue(documentFolder(doc));
                    setMoveTarget(doc);
                  }
                }
              ] as { label: string; icon: LucideIcon; act: () => void }[]
            ).map(({ label, icon: Icon, act }) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  setMenuFor(null);
                  act();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-parchment/80 hover:bg-parchment/10"
              >
                <Icon className="h-3.5 w-3.5 text-parchment/50" />
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setMenuFor(null);
                void removeDocument(doc.id);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-spark-orange/90 hover:bg-parchment/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <Card>
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} flex-1 min-w-[12rem]`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search documents…"
          aria-label="Search documents"
        />
        <select
          className={`${inputClass} w-auto`}
          value={audienceFilter}
          onChange={(e) => setAudienceFilter(e.target.value as typeof audienceFilter)}
          aria-label="Filter by audience"
        >
          <option value="all">All audiences</option>
          <option value="clients">Customers</option>
          <option value="staff">Internal only</option>
          <option value="both">Customers + internal</option>
        </select>
        <div className="flex rounded-md border border-parchment/15">
          <button
            type="button"
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            onClick={() => switchView("grid")}
            className={`rounded-l-md p-2 ${view === "grid" ? "bg-parchment/10 text-parchment" : "text-parchment/40 hover:text-parchment"}`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={view === "list"}
            onClick={() => switchView("list")}
            className={`rounded-r-md p-2 ${view === "list" ? "bg-parchment/10 text-parchment" : "text-parchment/40 hover:text-parchment"}`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => {
            setUploadCategory(folder ?? "");
            setUploadOpen(true);
          }}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          Upload
        </Button>
      </div>

      {/* ── Breadcrumb ─────────────────────────────────────────────────── */}
      <nav className="mt-4 flex items-center gap-1 text-sm" aria-label="Breadcrumb">
        <button
          type="button"
          onClick={() => goToFolder(null)}
          className={folder ? "text-parchment/50 hover:text-parchment" : "font-semibold text-parchment"}
        >
          Documents
        </button>
        {folder && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-parchment/30" />
            <span className="font-semibold text-parchment">{folder}</span>
          </>
        )}
        {searching && (
          <span className="ml-2 text-xs text-parchment/40">
            search results across all folders
          </span>
        )}
      </nav>

      {error ? (
        <p className="mt-2 text-xs text-spark-orange" role="alert">
          {error}
        </p>
      ) : null}

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div className="mt-4">
        {loading ? (
          <p className="text-sm text-parchment/40">Loading documents…</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-parchment/40">
            No documents yet — upload price sheets, policies, contracts, SOPs, or meeting
            transcripts and your coworker answers from them.
          </p>
        ) : searching && visibleDocs.length === 0 ? (
          <p className="text-sm text-parchment/40">No documents match your search.</p>
        ) : !searching && !folder ? (
          // Root: folder tiles.
          folderTiles.length === 0 ? (
            <p className="text-sm text-parchment/40">No documents match the current filter.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {folderTiles.map(([category, docs]) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => goToFolder(category)}
                  className="flex items-center gap-2.5 rounded-lg border border-parchment/10 bg-parchment/[0.03] px-3 py-3 text-left hover:border-signal-teal/40 transition-colors"
                >
                  <Folder className="h-5 w-5 shrink-0 text-signal-teal/80" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-parchment">
                      {category}
                    </span>
                    <span className="block text-[11px] text-parchment/40">
                      {docs.length} {docs.length === 1 ? "file" : "files"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )
        ) : visibleDocs.length === 0 ? (
          <p className="text-sm text-parchment/40">
            This folder is empty.{" "}
            <button
              type="button"
              onClick={() => goToFolder(null)}
              className="text-claw-green hover:underline"
            >
              Back to all documents
            </button>
          </p>
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleDocs.map((doc) => {
              const Icon = mimeIcon(doc.mime_type);
              return (
                <div
                  key={doc.id}
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/dashboard/documents/${doc.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") router.push(`/dashboard/documents/${doc.id}`);
                  }}
                  className="cursor-pointer rounded-lg border border-parchment/10 bg-parchment/[0.03] p-3 hover:border-signal-teal/40 transition-colors"
                >
                  <div className="flex items-start gap-2.5">
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-signal-teal/70" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-parchment">{doc.title}</p>
                      <p className="mt-0.5 text-[11px] text-parchment/40">
                        {formatByteSize(doc.byte_size)} · {doc.created_at.slice(0, 10)}
                        {searching ? ` · ${documentFolder(doc)}` : ""}
                      </p>
                    </div>
                    {kebab(doc)}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <span className="rounded border border-parchment/20 px-1.5 py-0.5 text-[10px] text-parchment/50">
                      {AUDIENCE_LABELS[doc.audience]}
                    </span>
                    <StatusBadges doc={doc} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-parchment/10 text-[11px] uppercase tracking-wider text-parchment/40">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Folder</th>
                  <th className="py-2 pr-3 font-medium">Audience</th>
                  <th className="py-2 pr-3 font-medium">Size</th>
                  <th className="py-2 pr-3 font-medium">Created</th>
                  <th className="py-2 font-medium" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visibleDocs.map((doc) => {
                  const Icon = mimeIcon(doc.mime_type);
                  return (
                    <tr
                      key={doc.id}
                      onClick={() => router.push(`/dashboard/documents/${doc.id}`)}
                      className="cursor-pointer border-b border-parchment/5 last:border-0 hover:bg-parchment/[0.04]"
                    >
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-2 text-parchment">
                          <Icon className="h-4 w-4 shrink-0 text-signal-teal/70" />
                          <span className="truncate font-medium">{doc.title}</span>
                          <StatusBadges doc={doc} />
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-parchment/50">{documentFolder(doc)}</td>
                      <td className="py-2 pr-3 text-parchment/50">
                        {AUDIENCE_LABELS[doc.audience]}
                      </td>
                      <td className="py-2 pr-3 text-parchment/50">
                        {formatByteSize(doc.byte_size)}
                      </td>
                      <td className="py-2 pr-3 text-parchment/50">{doc.created_at.slice(0, 10)}</td>
                      <td className="py-2 text-right">{kebab(doc)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Rename / Move modal ────────────────────────────────────────── */}
      {(renameTarget || moveTarget) && (
        <Modal
          title={renameTarget ? "Rename document" : "Move to folder"}
          onClose={() => {
            setRenameTarget(null);
            setMoveTarget(null);
          }}
        >
          <label className={labelClass}>
            {renameTarget ? "New title" : "Folder (category) — new names create the folder"}
          </label>
          <input
            className={inputClass}
            value={modalValue}
            onChange={(e) => setModalValue(e.target.value)}
            maxLength={renameTarget ? 200 : 100}
            placeholder={renameTarget ? undefined : "meeting / pricing / policies"}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRenameTarget(null);
                setMoveTarget(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={modalSaving}
              disabled={!modalValue.trim()}
              onClick={() => void submitModal()}
            >
              {renameTarget ? "Rename" : "Move"}
            </Button>
          </div>
        </Modal>
      )}

      {/* ── Upload modal ───────────────────────────────────────────────── */}
      {uploadOpen && (
        <Modal title="Upload document" onClose={() => setUploadOpen(false)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
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
              <label className={labelClass}>Folder (category, optional)</label>
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
          </div>
          {error ? (
            <p className="mt-2 text-xs text-spark-orange" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void upload()}
              loading={uploading}
            >
              Upload document
            </Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
