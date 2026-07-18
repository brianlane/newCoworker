"use client";

/**
 * Instagram posts manager (Dashboard → Marketing).
 *
 * Compose a post (caption + public image URL), leave it as a draft or
 * schedule it, and watch the per-minute sweep publish it through the
 * Instagram Graph API. Renders a connect prompt when the business has no
 * linked Instagram professional account — publishing rides the same Meta
 * connection as Lead Ads and DMs.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
  const [posts, setPosts] = useState<SocialPostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer.
  const [caption, setCaption] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [publishAt, setPublishAt] = useState("");
  const [saving, setSaving] = useState(false);

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

  // Always load: drafts/scheduled posts outlive a disconnected IG account,
  // and the owner must still be able to cancel or delete them here.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(asDraft: boolean) {
    if (!mediaUrl.trim()) {
      setError("Add the image URL (Instagram posts need an image).");
      return;
    }
    if (!asDraft && !publishAt) {
      setError("Pick a publish time (or save as a draft).");
      return;
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
          ...(!asDraft && publishAt ? { publishAt: new Date(publishAt).toISOString() } : {})
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Could not save the post");
        return;
      }
      setCaption("");
      setMediaUrl("");
      setPublishAt("");
      await refresh();
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
      await refresh();
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
      await refresh();
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
            <label className={labelClass}>Image URL (public https link — Instagram fetches it)</label>
            <input
              className={inputClass}
              value={mediaUrl}
              onChange={(e) => setMediaUrl(e.target.value)}
              placeholder="https://…/photo.jpg"
              maxLength={2000}
            />
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
              <label className={labelClass}>Publish at</label>
              <input
                type="datetime-local"
                className={inputClass}
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" size="sm" loading={saving} onClick={() => void create(false)}>
              Schedule post
            </Button>
            <Button type="button" variant="secondary" size="sm" loading={saving} onClick={() => void create(true)}>
              Save as draft
            </Button>
          </div>
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
                    <span className="max-w-[18rem] truncate text-sm text-parchment/90">
                      {p.caption.trim() || p.media_url}
                    </span>
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
