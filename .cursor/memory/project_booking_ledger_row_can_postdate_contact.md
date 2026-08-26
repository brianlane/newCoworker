---
name: booking-ledger-row-can-postdate-the-contact
description: calendar_booking_dedupe.created_at is not reliably before the contact rollup for the same booking; correlate with an absolute window
metadata: 
  node_type: memory
  type: project
  originSessionId: 2ab0cfff-3590-4add-9133-3eaa199933b3
  modified: 2026-08-17T06:51:57.202Z
---

For one booking-page submission, the `contacts` rollup and the
`calendar_booking_dedupe` row are written in either order. Reading
`submitPublicBooking` suggests the booking always lands first, and usually it
does (+12187702372: ledger 21:46:46.72, contact 21:46:50.04, so 3.3s after).
It is not a rule: +12092520704's contact rollup landed **41 seconds BEFORE**
its ledger row, because that row is not stamped at the moment the visitor
submits.

Found 2026-08-16 writing the booking_page backfill (PR #1416). The first
version required a non-negative gap and silently rejected a contact whose
`booking_source='booking_page'` row was sitting right there.

Also: not every booking-page contact HAS a ledger row. The oldest ones predate
`booking_source` being stamped, so two of six live candidates had none at all.

**Why:** Any job correlating a contact with the booking that created it will
quietly under-match on both counts, and the failure looks like a deliberate
"no match" rather than missing or mis-ordered evidence.

**How to apply:** Correlate on `Math.abs(gap) <= window`, never a signed
comparison, and have a fallback proof for rows the ledger cannot speak to. The
one that worked: `ensureCapturedContact` writes a source tag ONLY on the call
that created the row, so tag + `total_interaction_count === 1` +
`created_at === last_interaction_at` proves the creating interaction is still
the last one. See [[project_postgrest_write_matching_zero_rows]] and
[[feedback_verify_the_column_is_written]].
