/**
 * Shared client-side types + tiny display helpers for the Documents surfaces
 * (the Drive-style list in DocumentsManager and the per-document editor in
 * DocumentDetail). Pure data/formatting only — no fetching.
 */

export type DocumentItem = {
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
  record_fields: Record<string, string> | null;
  created_at: string;
};

export type ContactOption = { id: string; customerE164: string; displayName: string | null };

export type MemberOption = { id: string; name: string };

export const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
export const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

export const AUDIENCE_LABELS: Record<DocumentItem["audience"], string> = {
  clients: "Customers",
  staff: "Internal only",
  both: "Customers + internal"
};

/** The folder a document lives in — category, defaulting like the API does. */
export function documentFolder(doc: Pick<DocumentItem, "category">): string {
  return doc.category.trim() || "general";
}

export function formatByteSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(0)} KB`;
}

export function contactLabel(option: ContactOption): string {
  return option.displayName?.trim()
    ? `${option.displayName} (${option.customerE164})`
    : option.customerE164;
}

export function expiryBadge(doc: DocumentItem): { text: string; tone: string } | null {
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

export function renewalBadge(doc: DocumentItem): { text: string; tone: string } | null {
  if (!doc.renewal_date) return null;
  const ms = Date.parse(doc.renewal_date);
  if (!Number.isFinite(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days <= 0) {
    return { text: "Renewal overdue", tone: "text-spark-orange border-spark-orange/50" };
  }
  if (days <= 30) {
    return { text: `Renews in ${days}d`, tone: "text-spark-orange border-spark-orange/40" };
  }
  return {
    text: `Renews ${doc.renewal_date.slice(0, 10)}`,
    tone: "text-parchment/50 border-parchment/20"
  };
}

/**
 * Fetch a signed URL for the original upload and open/save it. `inline`
 * opens the browser's own viewer in a new tab (PDF viewer, plain text for
 * .vtt/.md/.csv); attachment mode saves via a transient anchor click so the
 * dashboard tab stays put. Returns an error message, or null on success.
 */
export async function openOriginalFile(
  businessId: string,
  docId: string,
  mode: "inline" | "attachment"
): Promise<string | null> {
  try {
    const qs = `businessId=${encodeURIComponent(businessId)}${
      mode === "inline" ? "&disposition=inline" : ""
    }`;
    const res = await fetch(`/api/dashboard/documents/${docId}/download?${qs}`, {
      cache: "no-store"
    });
    const json = (await res.json()) as {
      ok: boolean;
      data?: { url?: string };
      error?: { message?: string };
    };
    if (!json.ok || !json.data?.url) {
      return json.error?.message ?? "Could not create the link";
    }
    if (mode === "inline") {
      // window.open returns null when a popup blocker eats the tab — say so
      // instead of silently succeeding.
      const opened = window.open(json.data.url, "_blank", "noopener");
      if (!opened) {
        return "Your browser blocked the new tab — allow pop-ups for this site and try again.";
      }
    } else {
      const a = document.createElement("a");
      a.href = json.data.url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    return null;
  } catch {
    return "Could not create the link — try again.";
  }
}
