/**
 * Knowledge-graph SOURCE REGISTRY — the single declarative map of every
 * content surface in the platform to its graph-ingestion decision.
 *
 * Why this exists: "widen ingestion to everything" only stays true if a
 * future content surface cannot ship without a graph decision. The
 * kg-source-coverage test (tests/kg-source-coverage.test.ts) pins this
 * registry two ways — every live source's ingest call site must reference
 * its registry key, and the platform's content-surface inventory below is
 * asserted against the registry — so "we missed one" fails CI instead of
 * hiding for a quarter (same spirit as the agent-tool parity contract).
 *
 * Statuses:
 *   extracted     — LLM extraction feeds the graph (live hook).
 *   deterministic — structured data maps to entities/facts without a model
 *                   (live hook).
 *   planned       — decision made, hook ships in a named later PR of the
 *                   KG plan; flips to extracted/deterministic when it lands.
 *   exempt        — deliberately NOT ingested, with the reason stated.
 */

export type KgTrust = 0 | 1 | 2 | 3;

export type KgSourceEntry = {
  status: "extracted" | "deterministic" | "planned" | "exempt";
  /** Trust tier facts from this source carry (absent for exempt). */
  trust?: KgTrust;
  /** For planned: which PR of the KG plan delivers the hook. */
  plannedIn?: string;
  /** For exempt: why this surface deliberately stays out. */
  reason?: string;
};

export const KG_SOURCES = {
  // ── live today ─────────────────────────────────────────────────────────
  /** Owner dashboard chat + owner SMS rule capture (both funnel through the
   * owner-append chokepoint / inline capture → ingestBulletsIntoGraph). */
  owner_chat: { status: "extracted", trust: 3 },
  /** Historical memory_md replays (debug/kg-backfill.ts). */
  backfill: { status: "extracted", trust: 3 },

  // ── deterministic sources (live — hooks in graph-deterministic.ts) ──────
  team_roster: { status: "deterministic", trust: 3 },
  contacts: { status: "deterministic", trust: 3 },
  customer_pinned_notes: { status: "deterministic", trust: 3 },
  business_profile: { status: "deterministic", trust: 3 },
  aiflow_lead: { status: "deterministic", trust: 0 },
  booking: { status: "deterministic", trust: 2 },
  doc_extract_fields: { status: "deterministic", trust: 2 },

  // ── conversational sources (live) ────────────────────────────────────────
  /** Voice/SMS/replied-email windows extract at the customer-memory
   * summarizer boundary (debounced conversation close, per identified
   * customer) under the customer-source prompt. */
  voice_call: { status: "extracted", trust: 1 },
  customer_sms: { status: "extracted", trust: 1 },
  email_replied: { status: "extracted", trust: 1 },
  /** Cold inbound mail (no linked contact) extracts at anonymous trust —
   * the reply gate as attribution, not exclusion. */
  email_unanswered: { status: "extracted", trust: 0 },
  /** DM channels ingest at their lead-capture boundary: the model already
   * distilled the conversation into structured contact + interest, so the
   * mapping is deterministic (no second LLM pass). */
  messenger: { status: "deterministic", trust: 1 },
  whatsapp: { status: "deterministic", trust: 1 },
  webchat: { status: "deterministic", trust: 0 },

  // ── documents & long-form owner content (live — graph-longform.ts) ──────
  /** Condensed document bodies on every ingest/re-ingest, attributed to
   * the document title. */
  document: { status: "extracted", trust: 2 },
  /** website_md on every crawl, attributed to the site URL (the business's
   * voice, but a crawl is not the owner speaking — hence 2, not 3). */
  website: { status: "extracted", trust: 2 },
  /** identity_md on save — owner-authored onboarding write-up. */
  identity: { status: "extracted", trust: 3 },

  // ── deliberately exempt ────────────────────────────────────────────────
  /** AI assistant replies on any channel: assistant-invented content must
   * never become durable fact (the KYP incident) — only what the HUMAN side
   * of a conversation stated is extracted, with that side's trust. */
  assistant_replies: {
    status: "exempt",
    reason: "Assistant-invented content persisting as fact is the KYP failure mode."
  },
  /** Marketing/social composer posts: business-authored but derivative of
   * identity/website content that IS ingested; posts add no new facts. */
  social_posts: {
    status: "exempt",
    reason: "Derivative of ingested identity/website content; no novel facts."
  },
  /** Platform blog: HQ marketing content, not tenant knowledge. */
  platform_blog: { status: "exempt", reason: "Platform content, not tenant knowledge." }
} as const satisfies Record<string, KgSourceEntry>;

export type KgSource = keyof typeof KG_SOURCES;

/** Sources whose ingest hooks are live (must have call sites in src/). */
export function liveKgSources(): KgSource[] {
  return (Object.keys(KG_SOURCES) as KgSource[]).filter((key) => {
    const entry: KgSourceEntry = KG_SOURCES[key];
    return entry.status === "extracted" || entry.status === "deterministic";
  });
}

/** The trust tier a live/planned source's facts carry. */
export function kgSourceTrust(source: KgSource): KgTrust {
  const entry: KgSourceEntry = KG_SOURCES[source];
  if (entry.trust === undefined) {
    throw new Error(`kgSourceTrust: '${source}' is exempt and carries no trust tier`);
  }
  return entry.trust;
}
