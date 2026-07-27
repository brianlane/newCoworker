import { buildRobotsTxt } from "@/lib/marketing/robots-txt";

// Static: the policy is compiled in, so it changes on deploy, not per request.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(buildRobotsTxt(), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400"
    }
  });
}
