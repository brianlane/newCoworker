import { openAiAppsChallengeToken } from "@/lib/marketing/openai-apps";

// Read per request so rotating OPENAI_APPS_CHALLENGE_TOKEN in Vercel takes
// effect without a redeploy. OpenAI re-checks the challenge URL on every
// resubmission, so a stale token fails a review we are already waiting on.
export const dynamic = "force-dynamic";

/**
 * OpenAI Apps domain-ownership proof for the ChatGPT plugin submission.
 *
 * Deliberately mirrors src/app/indexnow-key.txt/route.ts: the token is public
 * by design (its only job is to prove whoever pasted it into the submission
 * portal controls this host), and an unset token 404s so the feature is
 * plainly off rather than serving an empty body that reads as a broken
 * endpoint.
 *
 * The body must be the bare token: no JSON, no trailing newline, no wrapper.
 */
export function GET(): Response {
  const token = openAiAppsChallengeToken();
  if (!token) return new Response("Not found", { status: 404 });
  return new Response(token, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}
