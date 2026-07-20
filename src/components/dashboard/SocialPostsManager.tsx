"use client";

/**
 * Instagram posts manager (Dashboard → Marketing).
 *
 * Compose a post (caption + an image — uploaded from the device, or a
 * public image URL for the link-minded), publish it now, schedule it, or
 * leave it as a draft; the per-minute sweep publishes through the
 * Instagram Graph API. Renders a connect prompt when the business has no
 * linked Instagram professional account — publishing rides the same Meta
 * connection as Lead Ads and DMs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export type SocialPostItem = {
  id: string;
  caption: string;
  media_url: string;
  status: "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  publish_at: string | null;
  published_at: string | null;
  ig_media_id: string | null;
  ig_permalink: string | null;
  error_detail: string | null;
  created_at: string;
};

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

const STATUS_BADGES: Record<SocialPostItem["status"], { text: string; tone: string }> = {
  draft: { text: "Draft", tone: "text-parchment/60 border-parchment/20" },
  scheduled: { text: "Scheduled", tone: "text-signal-teal border-signal-teal/40" },
  publishing: { text: "Publishing…", tone: "text-amber-300 border-amber-300/40" },
  published: { text: "Published", tone: "text-claw-green border-claw-green/40" },
  failed: { text: "Failed", tone: "text-spark-orange border-spark-orange/40" },
  cancelled: { text: "Cancelled", tone: "text-parchment/40 border-parchment/15" }
};

type Props = {
  businessId: string;
  /** Linked IG professional account (null = publishing unavailable). */
  instagramUsername: string | null;
  igConnected: boolean;
};

export function SocialPostsManager({ businessId, instagramUsername, igConnected }: Props) {
  const router = useRouter();
  const [posts, setPosts] = useState<SocialPostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer. The image is an uploaded ref (preferred) or a pasted URL —
  // whichever the owner set last wins, and each clears the other.
  const [caption, setCaption] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [publishAt, setPublishAt] = useState("");
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/social-posts?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: { posts?: SocialPostItem[] } };
      if (json.ok && json.data?.posts) setPosts(json.data.posts);
    } catch {
      /* keep the last list */
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  /**
   * Post-mutation refresh: this card's list AND the server components —
   * the unified content calendar's Instagram rows are server-rendered
   * (`calendarExtras`), so without router.refresh() a newly scheduled or
   * cancelled post would leave the calendar stale until a full reload.
   */
  const refreshEverywhere = useCallback(async () => {
    await refresh();
    router.refresh();
  }, [refresh, router]);

  // Always load: drafts/scheduled posts outlive a disconnected IG account,
  // and the owner must still be able to cancel or delete them here.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function uploadImage(file: File) {
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.set("businessId", businessId);
      form.set("file", file);
      const res = await fetch("/api/dashboard/images", { method: "POST", body: form });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { imageUrl?: string };
        error?: { message?: string };
      };
      if (!json.ok || !json.data?.imageUrl) {
        setError(json.error?.message ?? "Could not upload the image — try again.");
        return;
      }
      setMediaUrl(json.data.imageUrl);
      setUploadedName(file.name);
      setShowUrlInput(false);
    } catch {
      setError("Could not upload the image — try again.");
    } finally {
      setUploading(false);
      // Same-file re-selection must re-fire onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function create(mode: "schedule" | "now" | "draft") {
    if (!mediaUrl.trim()) {
      setError("Add an image — Instagram posts need one.");
      return;
    }
    if (mode === "schedule") {
      if (!publishAt) {
        setError('Pick a publish time — or use "Publish now" or save a draft.');
        return;
      }
      if (new Date(publishAt).getTime() < Date.now() - 60_000) {
        setError('That time is in the past — pick a future time, or use "Publish now".');
        return;
      }
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/dashboard/social-posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          mediaUrl: mediaUrl.trim(),
          ...(caption.trim() ? { caption: caption.trim() } : {}),
          ...(mode === "schedule" ? { publishAt: new Date(publishAt).toISOString() } : {}),
          ...(mode === "now" ? { publishNow: true } : {})
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Could not save the post");
        return;
      }
      setCaption("");
      setMediaUrl("");
      setUploadedName(null);
      setPublishAt("");
      await refreshEverywhere();
    } catch {
      setError("Could not save the post — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function cancel(postId: string) {
    try {
      const res = await fetch(`/api/dashboard/social-posts/${postId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, action: "cancel" })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) setError(json.error?.message ?? "Could not cancel");
      await refreshEverywhere();
    } catch {
      setError("Could not cancel — try again.");
    }
  }

  async function remove(postId: string) {
    if (!window.confirm("Delete this post?")) return;
    try {
      const res = await fetch(
        `/api/dashboard/social-posts/${postId}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) setError(json.error?.message ?? "Could not delete");
      await refreshEverywhere();
    } catch {
      setError("Could not delete — try again.");
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment">
        Instagram posts{igConnected && instagramUsername ? ` — @${instagramUsername}` : ""}
      </h2>
      {igConnected ? (
        <div className="mt-3 space-y-3">
          <div>
            <label className={labelClass}>Post image (JPEG, PNG, or WebP)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadImage(file);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadedName ? "Change image" : "Upload an image"}
              </Button>
              {uploadedName ? (
                <span className="max-w-[14rem] truncate text-xs text-claw-green">
                  ✓ {uploadedName}
                </span>
              ) : (
                <button
                  type="button"
                  className="text-xs text-parchment/50 underline hover:text-parchment"
                  onClick={() => setShowUrlInput((v) => !v)}
                >
                  or paste an image link
                </button>
              )}
            </div>
            {showUrlInput && !uploadedName && (
              <input
                className={`${inputClass} mt-2`}
                value={mediaUrl}
                onChange={(e) => setMediaUrl(e.target.value)}
                placeholder="https://…/photo.jpg (must be publicly reachable)"
                maxLength={2000}
              />
            )}
          </div>
          <div>
            <label className={labelClass}>Caption</label>
            <textarea
              className={`${inputClass} min-h-24`}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Spring special — book this week and save 20%! #smallbusiness"
              maxLength={2200}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Publish at (leave empty to publish now)</label>
              <input
                type="datetime-local"
                className={inputClass}
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {publishAt ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={saving}
                onClick={() => void create("schedule")}
              >
                Schedule post
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={saving}
                onClick={() => void create("now")}
              >
                Publish now
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={saving}
              onClick={() => void create("draft")}
            >
              Save as draft
            </Button>
          </div>
          <p className="text-[11px] text-parchment/40">
            &ldquo;Publish now&rdquo; posts within about a minute. Scheduled posts publish at
            their set time.
          </p>
        </div>
      ) : (
        // No composer without a linked IG account — but existing drafts and
        // scheduled posts stay listed below so they can be cancelled/deleted
        // (nothing will publish while disconnected; the sweep fails them
        // with reconnect guidance).
        <div className="mt-2">
          <p className="text-sm text-parchment/60">
            Schedule Instagram posts right from your marketing calendar. Connect your
            Facebook Page (with its linked Instagram professional account) to enable
            publishing.
          </p>
          <Link
            href="/dashboard/integrations/meta"
            className="mt-2 inline-block text-sm text-signal-teal hover:underline"
          >
            Connect on the Integrations page →
          </Link>
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-spark-orange" role="alert">
          {error}
        </p>
      )}

      <div className="mt-5">
        {loading ? (
          <p className="text-sm text-parchment/40">Loading…</p>
        ) : posts.length === 0 ? (
          igConnected ? (
            <p className="text-sm text-parchment/40">No posts yet — compose one above.</p>
          ) : null
        ) : (
          <ul className="divide-y divide-parchment/10">
            {posts.map((p) => {
              const badge = STATUS_BADGES[p.status];
              return (
                <li key={p.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {p.ig_permalink ? (
                      <a
                        href={p.ig_permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="max-w-[18rem] truncate text-sm text-signal-teal hover:underline"
                        title="View the post on Instagram"
                      >
                        {p.caption.trim() || p.media_url}
                      </a>
                    ) : (
                      <span className="max-w-[18rem] truncate text-sm text-parchment/90">
                        {p.caption.trim() || p.media_url}
                      </span>
                    )}
                    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${badge.tone}`}>
                      {badge.text}
                    </span>
                    {p.publish_at && (
                      <span className="text-[11px] text-parchment/40">
                        {new Date(p.publish_at).toLocaleString()}
                      </span>
                    )}
                    <span className="ml-auto flex gap-2">
                      {(p.status === "draft" || p.status === "scheduled") && (
                        <button
                          type="button"
                          onClick={() => void cancel(p.id)}
                          className="text-[11px] text-parchment/50 hover:text-parchment"
                        >
                          Cancel
                        </button>
                      )}
                      {p.status !== "publishing" && (
                        <button
                          type="button"
                          onClick={() => void remove(p.id)}
                          className="text-[11px] text-spark-orange/80 hover:text-spark-orange"
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </div>
                  {p.status === "failed" && p.error_detail ? (
                    <p className="mt-1 text-[11px] text-spark-orange/90">{p.error_detail}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
