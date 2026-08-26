---
name: project_fub_api_terms_forbid_migration
description: "Follow Up Boss's API ToU forbid competing products, data retention and AI use; the importer was rebuilt on their own CSV export (PR #1573)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 41d50d64-2613-47ac-9645-3b2e405fe4bf
  modified: 2026-08-21T07:31:26.138Z
---

Follow Up Boss (owned by Zillow) publishes [API Terms of Use](https://docs.followupboss.com/reference/fub-api-tou) SEPARATE from their main terms. They forbid what a migration tool does: system registration is required first; no products "not intended for use by FUB customers or for use with FUB's products" and nothing that competes with them; no retaining their data beyond what an integration needs; no using their data in connection with AI or ML model development or training; no competitive analysis or benchmarking. They may suspend API access at any time, without notice.

PR #1553 shipped an API-key importer on 2026-08-20 that broke all four. It was live and ungated on `/dashboard/import-export` for one day. **PR #1573 (merged `18401ad7e`) replaced it with their own CSV export path** and dropped `fub_import_jobs.api_key_encrypted` and `.cursor`. Checked before dropping: the table held ZERO rows, so no customer ever ran it and no key was ever stored.

**Why:** the compliant path is the one the vendor documents for their own customers. Follow Up Boss tells admins to export from People with "Export All Columns" specifically to upload elsewhere, and emails the account owner when an export happens. The data owner hands it over; we never touch their account.

**How to apply:**
- Before building any competitor-migration or data-pull feature, read that vendor's API terms as a separate document from their ToS. A public REST API with key auth is not permission.
- Prefer the vendor's own customer-facing export over their API for anything migration-shaped.
- Cost of the CSV path: contacts, tags, stage and lead source come across; **notes and deals do not** (not in the export), nor smart lists or action plans. Say that in the UI and the marketing copy rather than letting a customer discover it post-migration.
- The export's headers are unpublished and vary by Smart List, so `src/lib/fub-import/map.ts` matches headers by PATTERN and the preview names every column it ignored.
- Public copy lives at `/compare/follow-up-boss` (PR #1572, merged `fdd6bad3c`). Competitor claims there must stay sourced and dated; see the header comment in `src/app/(marketing)/compare/data.ts`.

Counsel has not reviewed either version. See [[project_legal_gap_closure_plan]].
