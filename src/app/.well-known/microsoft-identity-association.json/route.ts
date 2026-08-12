/**
 * Microsoft publisher-domain proof for the "New Coworker" Entra app.
 *
 * Entra defaults a new registration's publisher domain to the tenant's
 * `*.onmicrosoft.com`, which it then refuses for publisher verification
 * ("onmicrosoft.com publisher domains are not allowed"). Setting a custom
 * domain is the way out, and this file is how Entra proves we own it: paste the
 * domain under Branding & properties -> Update domain, and Entra fetches
 * `https://<domain>/.well-known/microsoft-identity-association.json` and looks
 * for the application id below.
 *
 * That matters beyond a badge. The app is multitenant
 * (AzureADandPersonalMicrosoftAccount), and many Entra tenants default user
 * consent to "apps from verified publishers only", so while we are unverified
 * an ordinary user at a customer org cannot grant consent at all: they bounce
 * with AADSTS65001 and need an admin. Personal Microsoft accounts are
 * unaffected, which is the trap, since a solo test against a personal Outlook
 * passes and proves nothing about org tenants.
 *
 * Mirrors src/app/.well-known/openai-apps-challenge/route.ts: the id is public
 * by design (its only job is to prove whoever pasted it into the portal
 * controls this host), and it is read per request so rotating
 * MICROSOFT_CLIENT_ID in Vercel takes effect without a redeploy.
 *
 * The body must be exactly this JSON shape; Entra ignores anything else.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const applicationId = process.env.MICROSOFT_CLIENT_ID;
  // Unset means first-party Outlook is not configured on this deploy. 404 so
  // the endpoint reads as plainly off, rather than serving an empty
  // associatedApplications array that Entra would reject as a failed proof.
  if (!applicationId) return new Response("Not found", { status: 404 });

  return new Response(JSON.stringify({ associatedApplications: [{ applicationId }] }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
