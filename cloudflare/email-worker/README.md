# nc-email-inbound (Cloudflare Email Worker)

Catches inbound mail to per-tenant AI mailboxes (`<tenant>@newcoworker.com`) and
forwards it to the app's `/api/email/inbound` webhook, which resolves the tenant
and triggers any matching `tenant_email` AiFlows.

## How it fits together

```
sender -> Cloudflare Email Routing (MX on newcoworker.com)
       -> catch-all rule "Send to a Worker" (this worker)
       -> POST /api/email/inbound (Bearer EMAIL_INBOUND_SECRET)
       -> resolve tenant, log on Emails page, enqueue tenant_email flows
```

Explicit routing rules (`contact@`, `team@` -> Gmail) take precedence over the
catch-all, so platform mail is untouched.

## Deploy

```bash
cd cloudflare/email-worker
npm install
npx wrangler secret put EMAIL_INBOUND_SECRET   # MUST match the app's EMAIL_INBOUND_SECRET
npx wrangler deploy
```

Then in the Cloudflare dashboard: **Email Routing -> Routing rules -> Catch-all
-> Action: Send to a Worker -> nc-email-inbound -> Save** (and ensure the
catch-all toggle is enabled).

## Config (`wrangler.toml` `[vars]`)

- `APP_INBOUND_URL` - public URL of the app webhook (e.g. `https://app.newcoworker.com/api/email/inbound`).
- `PLATFORM_EMAIL_DOMAIN` - mail from this domain is dropped (loop guard).

## Secret

- `EMAIL_INBOUND_SECRET` - shared bearer; set via `wrangler secret put`, never committed.
