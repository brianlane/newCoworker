---
name: legal-gap-closure-plan
description: "Legal-surface overhaul SHIPPED Aug 1-2 2026 (PRs 1122, 1128, 1130, 1132); what landed and what deliberately remains open"
metadata: 
  node_type: memory
  type: project
  originSessionId: be5bf419-31ad-42e0-a880-f4d4ca650a43
  modified: 2026-08-02T05:50:29.954Z
---

Shipped 2026-08-01/02, all merged and deployed green: PR #1122 (legal pages refreshed, guarantee marketing de-overclaimed), PR #1128 (deletion.ts + retention.ts cover every person-data store: webchat, messenger/WhatsApp, memory graph with box vault re-sync, coworker_logs, leads, waitlist, dedupe, handoff, outreach REDACTED not deleted, campaign recipients, email-attachment objects; tests/privacy-coverage.test.ts guard forces a decision for every business_id table), PR #1130 (terms_acceptances ledger, clickwrap on /onboard/success set-password + /signup, dashboard TermsAcceptanceGate, versions in src/lib/legal/versions.ts: bumping a date re-raises the gate fleet-wide), PR #1132 (guard registry entry for terms_acceptances after #1128's guard correctly blocked the merged-main deploy when #1130's migration crossed it in flight).

Bugbot found 7 real findings across these PRs; the erasure design rules that came out of them: phone-only erasure follows contact emails ONE HOP (symmetric with email-to-numbers), attributed_to emails match via escaped-literal ilike (raw casing in graph ingestion), suppression rows (sms_opt_outs, outreach domains, terms_acceptances) must SURVIVE erasure.

Deliberately still open (counsel/founder decisions, in the plan file): arbitration clause, voice AI self-disclosure posture + translator-mode caller announcement, CAPI default-on, tenant-facing retention setting, Zoom marketplace PDF regeneration. Plan file: /Users/brianlane/.claude/plans/legal-gaps-deletion-and-acceptance.md.
