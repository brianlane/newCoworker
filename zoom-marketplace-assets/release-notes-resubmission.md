# Release notes for Zoom resubmission (paste into the submission form)

Thank you for the detailed review notes. All six have been addressed:

1. ACCOUNT TYPE: The submitting Zoom account has been upgraded to "Free with Credit Card".

2. TEST PLAN: A step-by-step reviewer walkthrough covering authorization, every requested scope (meeting create / update / delete / read, invite links, user read), and removal is here:
https://www.newcoworker.com/integrations/zoom/review-test-plan

3. TEST CREDENTIALS (reviewer account on our production environment, which uses the Production Client ID for authorization):
URL: https://www.newcoworker.com/login
Email: zoom.reviewer@newcoworker.com
(The reviewer account's sign-in credential is NOT stored in this repo — it was
submitted directly in the Zoom form. Re-mint it with
`tsx debug/zoom-reviewer-setup.ts --apply` if it is ever lost.)
The account owns a pre-configured sandbox business ("Zoom Review Sandbox") with dashboard access to the Integrations page and the booking chat used in the test plan. Connect any Zoom account (a free account works) in Step 2 of the plan.

4. DOCUMENTATION URL: End-user documentation covering how to add, use, and remove the integration is now published at:
https://www.newcoworker.com/integrations/zoom
(The Documentation URL field in the app listing has been updated to this address.)

5. CONTACT EMAIL: The developer contact email has been updated to a corporate address: team@newcoworker.com.

6. DEV / PROD REDIRECT URLS: Acknowledged. The production redirect URL is https://www.newcoworker.com/api/integrations/zoom/callback. We will stand up a dedicated staging environment with its own development redirect URL before any future update request that changes scopes.

TLS: all endpoints are HTTPS-only and negotiate TLS 1.2 or higher (HSTS preload enabled).

Security evidence (SSDLC, SAST & DAST results, privacy policy, security policy, vulnerability management procedures, infrastructure/dependency management policy) is attached in the Technical Design section from the previous resubmission.
