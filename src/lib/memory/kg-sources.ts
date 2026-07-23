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

  // ── deterministic sources (PR 3) ───────────────────────────────────────
  team_roster: { status: "planned", trust: 3, plannedIn: "PR 3" },
  contacts: { status: "planned", trust: 3, plannedIn: "PR 3" },
  customer_pinned_notes: { status: "planned", trust: 3, plannedIn: "PR 3" },
  business_profile: { status: "planned", trust: 3, plannedIn: "PR 3" },
  aiflow_lead: { status: "planned", trust: 0, plannedIn: "PR 3" },
  booking: { status: "planned", trust: 2, plannedIn: "PR 3" },
  doc_extract_fields: { status: "planned", trust: 2, plannedIn: "PR 3" },

  // ── conversational extraction (PR 4) ───────────────────────────────────
  voice_call: { status: "planned", trust: 1, plannedIn: "PR 4" },
  customer_sms: { status: "planned", trust: 1, plannedIn: "PR 4" },
  messenger: { status: "planned", trust: 1, plannedIn: "PR 4" },
  whatsapp: { status: "planned", trust: 1, plannedIn: "PR 4" },
  webchat: { status: "planned", trust: 0, plannedIn: "PR 4" },
  email_replied: { status: "planned", trust: 1, plannedIn: "PR 4" },
  email_unanswered: { status: "planned", trust: 0, plannedIn: "PR 4" },

  // ── documents & long-form owner content (PR 5) ─────────────────────────
  document: { status: "planned", trust: 2, plannedIn: "PR 5" },
  website: { status: "planned", trust: 2, plannedIn: "PR 5" },
  identity: { status: "planned", trust: 3, plannedIn: "PR 5" },

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
