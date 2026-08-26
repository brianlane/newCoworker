import { redirect } from "next/navigation";

/**
 * The API reference at /docs/api is the only doc page so far. This exists so
 * the bare /docs path resolves instead of 404ing, and it can become a real
 * index once there is a second doc page. Deliberately absent from sitemap.ts:
 * a redirect is not a destination.
 */
export default function DocsIndexRedirectPage() {
  redirect("/docs/api");
}
