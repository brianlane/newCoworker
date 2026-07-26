import { buildLlmsTxt } from "@/lib/marketing/llms-content";

// Static: the short index states only facts that live in code, so it changes
// on deploy, not per request.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(buildLlmsTxt(), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400"
    }
  });
}
