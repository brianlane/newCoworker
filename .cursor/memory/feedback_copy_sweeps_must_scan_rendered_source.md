---
name: feedback-copy-sweeps-must-scan-rendered-source
description: "Changing user-facing policy copy: grep rendered source, not just the i18n catalogs, because some components hardcode their text inline"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e034095f-5412-4df8-a8f3-131c22432ce1
  modified: 2026-08-17T15:31:14.955Z
---

When a policy change requires updating customer-facing wording, searching
`messages/en.json`, `messages/es.json` and the Terms/FAQ pages is NOT
sufficient. Some components hardcode their copy inline and never read the
i18n catalog, so a catalog-based sweep cannot see them.

**Why:** removing the term refund deduction (PR #1393) updated Terms section
9, both FAQs, the pricing note and the checkout summary, and missed
`src/components/billing/CancelSheet.tsx`, which is hardcoded English. That is
the sheet a customer reads at the moment they click cancel, so for two days it
quoted a Standard 24-month customer $195 LESS than we actually refund, on the
one screen where the number matters most. Brian caught it from a screenshot,
not CI. Fixed in #1417.

**How to apply:** for any user-facing policy wording change, grep the rendered
sources too:

```bash
grep -rniE "<the claim>" messages/ src/app/ src/components/ src/lib/email/ supabase/functions/_shared/
```

Then verify what production actually SERVES rather than trusting the repo:
`curl -sL -H 'Accept-Language: en-US' https://www.newcoworker.com/<path>`
(use www; the apex 308-redirects, and see
[[project-cloudflare-scraper-rules-block-googlebot]] for the Accept-Language
header). A stale browser tab is not evidence either way.

`tests/refund-policy-copy.test.ts` now guards this ONE claim by scanning
rendered source. Consider the same shape for the next policy claim worth
pinning, and anchor the patterns with `\b`: an unanchored `less one month`
matches inside `unless one month`, and a guard that fires on innocent copy
gets deleted by whoever trips it.

Related: [[feedback-verify-the-column-is-written]].
