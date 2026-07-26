import { indexNowKey } from "@/lib/marketing/indexnow";

// Read per request so rotating INDEXNOW_KEY in Vercel takes effect without a
// redeploy (a stale key file is a 403 on every submission).
export const dynamic = "force-dynamic";

/**
 * IndexNow ownership proof. The key is public by design: the engines fetch
 * this file over plain HTTP to confirm whoever submitted URLs controls the
 * host. 404 when unset, so the feature is simply off rather than serving an
 * empty file that reads as a misconfiguration.
 */
export function GET(): Response {
  const key = indexNowKey();
  if (!key) return new Response("Not found", { status: 404 });
  return new Response(key, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}
