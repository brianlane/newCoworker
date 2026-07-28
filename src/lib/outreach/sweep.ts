/**
 * Prospecting — the sweep. One pass over every business the feature is on for.
 *
 * Call chain: pg_cron (every 5 min) -> Edge `outreach-sweep`
 *   -> POST /api/internal/outreach-sweep -> here.
 *
 * Four phases per business, each independently idempotent so the next tick
 * converges after any failure:
 *
 *   1. DISCOVER (once per UTC day) Places queries from the tenant's own
 *      targeting, filtered to prospects worth probing, filed as ledger rows.
 *   2. DRAFT probe each new prospect, find an address, compose the pitch.
 *      Manual mode stops here and waits for the owner.
 *   3. SEND (auto only, inside the window, under the cap) send from the
 *      tenant's own mailbox, then hand the prospect to the tenant's AiFlow for
 *      filing and the owner brief.
 *   4. NUDGE one follow-up per prospect, ever, to those who went quiet.
 *
 * WHY THE SEND LIVES HERE AND NOT IN THE FLOW'S send_email STEP. The pitch
 * carries a legally required unsubscribe link and postal address. A flow step's
 * body is owner-editable copy, so putting the pitch there would make the
 * compliance footer something an owner could delete by accident. Composing and
 * sending in code makes the footer structural, and makes `sent_at` evidence (a
 * provider message id came back) rather than an inference. The flow still owns
 * everything after the send, which is what an owner should control.
 */

import { getBusiness } from "@/lib/db/businesses";
import { schedulingLink } from "@/lib/booking-page/prompt-line";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import {
  countEnabledWebhookFlows,
  processWebhookFlowEvent
} from "@/lib/ai-flows/webhook-events";
import { PROSPECT_OUTREACH_SOURCE } from "@/lib/ai-flows/templates";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import {
  countProspectsNudgedSince,
  countProspectsSentSince,
  existingProspectDomains,
  insertProspects,
  listActiveOutreachSettings,
  listProspectsByStatus,
  listProspectsDueForNudge,
  patchProspect,
  transitionProspect,
  upsertOutreachSettings,
  type OutreachProspectRow,
  type OutreachSettingsRow
} from "./db";
import {
  buildQueryRotation,
  dayIndexFor,
  prospectsFromHits,
  QUERIES_PER_RUN,
  rotationWindow,
  searchPlaces
} from "./discover";
import { probeSite } from "./probe";
import {
  assembleBody,
  composePitch,
  isPitchable,
  leadFinding,
  pitchParagraphs,
  polishParagraphs,
  type PitchTenant
} from "./compose";
import {
  buildOutreachUnsubscribeUrl,
  discoveryDueToday,
  isWithinSendWindow,
  utcDayStartIso
} from "./compliance";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Prospects probed per pass, as a multiple of the daily cap. */
export const DRAFT_BUDGET_MULTIPLIER = 2;

/** Floor on the per-pass draft budget, for tenants with a tiny cap. */
export const DRAFT_BUDGET_MIN = 4;

/** Days of silence before the single follow-up goes out. */
export const NUDGE_AFTER_DAYS = 5;

/** Past this age a prospect is left alone: a late nudge reads as a stranger. */
export const NUDGE_STALE_AFTER_DAYS = 21;

/** Follow-ups per pass, per business. */
export const NUDGE_BATCH = 5;

export type OutreachSweepResult = {
  businesses: number;
  discovered: number;
  drafted: number;
  sent: number;
  nudged: number;
  /** Prospects retired without a send, with the honest reason. */
  skipped: number;
  /**
   * Conditions that stopped work without being failures: no Places key, no
   * targeting, cap reached, outside the window. Surfaced so the owner surface
   * can explain a quiet day instead of looking broken.
   */
  notes: Array<{ businessId: string; note: string }>;
  errors: Array<{ businessId: string; message: string }>;
};

export type OutreachSweepDeps = {
  client?: SupabaseClient;
  now?: () => Date;
  placesApiKey?: string;
  appUrl?: string;
  searchPlacesImpl?: typeof searchPlaces;
  probeSiteImpl?: typeof probeSite;
  polishImpl?: typeof polishParagraphs;
  sendEmailImpl?: typeof sendFromOwnerMailbox;
  getBusinessImpl?: typeof getBusiness;
  schedulingLinkImpl?: typeof schedulingLink;
  processFlowEventImpl?: typeof processWebhookFlowEvent;
  countFlowsImpl?: typeof countEnabledWebhookFlows;
  recordEmailLogImpl?: typeof recordOutreachEmailLog;
};

/** Every dependency resolved once, so the phases below take no optionals. */
type Resolved = {
  db: SupabaseClient;
  now: Date;
  placesApiKey: string;
  appUrl: string;
  searchPlaces: typeof searchPlaces;
  probeSite: typeof probeSite;
  polish: typeof polishParagraphs;
  sendEmail: typeof sendFromOwnerMailbox;
  getBusiness: typeof getBusiness;
  schedulingLink: typeof schedulingLink;
  processFlowEvent: typeof processWebhookFlowEvent;
  countFlows: typeof countEnabledWebhookFlows;
  recordEmailLog: typeof recordOutreachEmailLog;
};

/* c8 ignore start -- production defaults; every test injects its own */
async function resolveDeps(deps: OutreachSweepDeps): Promise<Resolved> {
  return {
    db: deps.client ?? (await createSupabaseServiceClient()),
    now: (deps.now ?? (() => new Date()))(),
    placesApiKey: deps.placesApiKey ?? process.env.GOOGLE_PLACES_API_KEY ?? "",
    appUrl: deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    searchPlaces: deps.searchPlacesImpl ?? searchPlaces,
    probeSite: deps.probeSiteImpl ?? probeSite,
    polish: deps.polishImpl ?? polishParagraphs,
    sendEmail: deps.sendEmailImpl ?? sendFromOwnerMailbox,
    getBusiness: deps.getBusinessImpl ?? getBusiness,
    schedulingLink: deps.schedulingLinkImpl ?? schedulingLink,
    processFlowEvent: deps.processFlowEventImpl ?? processWebhookFlowEvent,
    countFlows: deps.countFlowsImpl ?? countEnabledWebhookFlows,
    recordEmailLog: deps.recordEmailLogImpl ?? recordOutreachEmailLog
  };
}
/* c8 ignore stop */

/**
 * Log the send onto `email_log` so it appears on the owner's Emails page beside
 * every other coworker email. Best-effort: the mail has already gone, and a
 * logging failure must not make the ledger claim it has not.
 */
export async function recordOutreachEmailLog(
  db: SupabaseClient,
  args: {
    businessId: string;
    to: string;
    from: string;
    subject: string;
    body: string;
    providerMessageId: string | null;
  }
): Promise<void> {
  const { error } = await db.from("email_log").insert({
    business_id: args.businessId,
    direction: "outbound",
    to_email: args.to,
    from_email: args.from,
    subject: args.subject,
    body_preview: args.body.slice(0, 500),
    source: "owner_mailbox",
    provider_message_id: args.providerMessageId
  });
  if (error) logger.warn("outreach: email_log insert failed", { error: error.message });
}

/** The tenant identity every pitch is written from. */
async function resolveTenant(
  settings: OutreachSettingsRow,
  r: Resolved
): Promise<{ tenant: PitchTenant; timeZone: string | null } | { missing: string }> {
  const business = await r.getBusiness(settings.business_id, r.db);
  if (!business) return { missing: "business row is gone" };
  // The DB constraint guarantees a postal address for any non-off mode, so
  // this is belt-and-braces rather than the primary gate.
  const postalAddress = settings.postal_address?.trim() ?? "";
  if (!postalAddress) return { missing: "no postal address configured" };
  const valueProp = settings.value_prop?.trim() ?? "";
  if (!valueProp) return { missing: "no value proposition configured" };
  const link = await r.schedulingLink(settings.business_id).catch(() => null);
  return {
    tenant: {
      name: business.name.trim(),
      valueProp,
      website: (business as { website_url?: string | null }).website_url?.trim() || null,
      bookingUrl: link?.url ?? null,
      senderName: settings.sender_name?.trim() || null,
      postalAddress
    },
    timeZone: business.timezone ?? null
  };
}

/** Phase 1: buy the day's Places queries and file what comes back. */
async function discoverForBusiness(
  settings: OutreachSettingsRow,
  r: Resolved,
  result: OutreachSweepResult
): Promise<void> {
  if (!r.placesApiKey) {
    result.notes.push({ businessId: settings.business_id, note: "no Places API key configured" });
    return;
  }
  const rotation = buildQueryRotation(settings.search_terms, settings.cities);
  if (rotation.length === 0) {
    result.notes.push({
      businessId: settings.business_id,
      note: "no search terms or cities configured"
    });
    return;
  }
  // Stamp BEFORE the queries, not after: these calls cost money, and a crash
  // halfway through must not let the next tick buy the same searches again.
  // At-most-once beats at-least-once when the retry is billable.
  await upsertOutreachSettings(
    settings.business_id,
    { last_discovery_at: r.now.toISOString() },
    r.db
  );
  for (const slot of rotationWindow(rotation, dayIndexFor(r.now), QUERIES_PER_RUN)) {
    const hits = await r.searchPlaces(r.placesApiKey, slot.query);
    const candidates = prospectsFromHits(hits, slot.vertical, slot.city);
    const suppressed = await existingProspectDomains(
      settings.business_id,
      candidates.map((c) => c.domain),
      r.db
    );
    const fresh = candidates.filter((c) => !suppressed.has(c.domain));
    const inserted = await insertProspects(
      fresh.map((c) => ({
        business_id: settings.business_id,
        domain: c.domain,
        business_name: c.businessName,
        website: c.website,
        phone: c.phone,
        vertical: c.vertical,
        city: c.city
      })),
      r.db
    );
    result.discovered += inserted.length;
  }
}

/** Phase 2: probe, find an address, compose. Retires what cannot be pitched. */
async function draftForBusiness(
  settings: OutreachSettingsRow,
  tenant: PitchTenant,
  r: Resolved,
  result: OutreachSweepResult
): Promise<void> {
  const budget = Math.max(DRAFT_BUDGET_MIN, settings.daily_cap * DRAFT_BUDGET_MULTIPLIER);
  const pending = await listProspectsByStatus(settings.business_id, ["discovered"], budget, r.db);

  for (const prospect of pending) {
    const retire = async (detail: string): Promise<void> => {
      await patchProspect(
        settings.business_id,
        prospect.id,
        { status: "skipped", status_detail: detail },
        r.db
      );
      result.skipped += 1;
    };

    const probed = await r.probeSite(
      prospect.website ?? `https://${prospect.domain}`,
      prospect.domain
    );
    if (!probed.reachable) {
      await retire(probed.failure ?? "site unreadable");
      continue;
    }
    if (!probed.email) {
      await retire("no published contact address");
      continue;
    }
    if (!isPitchable(probed.findings)) {
      await retire("nothing checkable to say about their site");
      continue;
    }
    // Claiming the address can lose to the partial unique index when another
    // prospect of this business already fronts it (a shared owner, or one
    // agency running both sites). That is a duplicate to retire, not an error.
    const claimed = await patchProspect(
      settings.business_id,
      prospect.id,
      { email: probed.email, findings: probed.findings },
      r.db
    );
    if (!claimed) {
      await retire("another prospect already uses this address");
      continue;
    }

    const unsubscribeUrl = buildOutreachUnsubscribeUrl(
      r.appUrl,
      settings.business_id,
      prospect.id
    );
    const pitchProspect = {
      businessName: prospect.business_name,
      city: prospect.city,
      findings: probed.findings
    };
    // isPitchable already proved a lead finding with an honest opening exists,
    // so composePitch cannot come back empty here.
    const deterministic = composePitch(
      tenant,
      pitchProspect,
      unsubscribeUrl
    ) as { subject: string; body: string };
    const lead = leadFinding(probed.findings) as { code: string; detail: string };
    // Polish the middle only, then re-assemble: the footer never reaches a
    // model, so it cannot be reworded away.
    const polished = await r.polish(
      settings.business_id,
      pitchParagraphs(tenant, pitchProspect, lead)
    );
    await patchProspect(
      settings.business_id,
      prospect.id,
      {
        status: "drafted",
        status_detail: null,
        drafted_at: r.now.toISOString(),
        pitch_subject: deterministic.subject,
        pitch_body: assembleBody(tenant, polished, unsubscribeUrl)
      },
      r.db
    );
    result.drafted += 1;
  }
}

/**
 * Phase 3: send first pitches, up to `allowance`. Returns how many went out so
 * the caller can spend what is left of the cap on follow-ups.
 */
async function sendForBusiness(
  settings: OutreachSettingsRow,
  tenant: PitchTenant,
  r: Resolved,
  result: OutreachSweepResult,
  allowance: number
): Promise<number> {
  const drafted = await listProspectsByStatus(settings.business_id, ["drafted"], allowance, r.db);
  let sentThisPass = 0;

  for (const prospect of drafted) {
    // A drafted row should always carry an address and pitch text. If one
    // somehow does not, it is recorded as failed rather than sent with an
    // empty subject: a blank cold email is worse than none, and a silent
    // fallback would hide whatever produced the bad row.
    const to = prospect.email;
    const subject = prospect.pitch_subject?.trim();
    const body = prospect.pitch_body?.trim();
    if (!to || !subject || !body) {
      await recordSendFailure(
        settings,
        prospect,
        r,
        "sent_at",
        "draft is missing its address or pitch text"
      );
      continue;
    }
    const sent = await deliverPitch(settings, tenant, prospect, r, {
      to,
      subject,
      body,
      fromStatus: "drafted",
      stamp: "sent_at"
    });
    if (!sent) continue;
    result.sent += 1;
    sentThisPass += 1;
    await handOffToFlow(settings, prospect, r, result, { email: to, subject });
  }
  return sentThisPass;
}

/** Phase 4: the single follow-up, for prospects who went quiet. */
async function nudgeForBusiness(
  settings: OutreachSettingsRow,
  tenant: PitchTenant,
  r: Resolved,
  result: OutreachSweepResult,
  allowance: number
): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  const due = await listProspectsDueForNudge(
    settings.business_id,
    new Date(r.now.getTime() - NUDGE_STALE_AFTER_DAYS * day).toISOString(),
    new Date(r.now.getTime() - NUDGE_AFTER_DAYS * day).toISOString(),
    allowance,
    r.db
  );
  for (const prospect of due) {
    const to = prospect.email;
    // Same reasoning as the send phase: no address means nothing to do, and
    // silently "succeeding" would burn this prospect's one follow-up.
    if (!to) continue;
    const unsubscribeUrl = buildOutreachUnsubscribeUrl(
      r.appUrl,
      settings.business_id,
      prospect.id
    );
    const body = assembleBody(
      tenant,
      [
        `Hi ${prospect.business_name.trim() || "there"},`,
        "I wrote last week about what I noticed on your site. If it is not useful, no problem at all and I will leave it there.",
        "If it is, I am happy to walk you through it."
      ],
      unsubscribeUrl
    );
    // The nudge rides the ORIGINAL subject so it reads as the same conversation.
    const sent = await deliverPitch(settings, tenant, prospect, r, {
      to,
      subject: prospect.pitch_subject?.trim() || "Following up",
      body,
      fromStatus: "sent",
      stamp: "nudged_at"
    });
    if (sent) result.nudged += 1;
  }
}

/**
 * Claim the prospect, send the mail, log it. The claim comes FIRST and is
 * guarded on the status we expect, so two overlapping sweeps cannot both mail
 * one prospect; a send that then fails is recorded as failed rather than
 * silently retried, because a duplicate cold email is a spam complaint while a
 * missed one costs nothing.
 */
async function deliverPitch(
  settings: OutreachSettingsRow,
  tenant: PitchTenant,
  prospect: OutreachProspectRow,
  r: Resolved,
  mail: {
    to: string;
    subject: string;
    body: string;
    fromStatus: "drafted" | "sent";
    stamp: "sent_at" | "nudged_at";
  }
): Promise<boolean> {
  const to = mail.to;
  const claimed = await transitionProspect(
    settings.business_id,
    prospect.id,
    mail.fromStatus,
    mail.stamp === "sent_at"
      ? { status: "sent", sent_at: r.now.toISOString() }
      : { nudged_at: r.now.toISOString() },
    r.db
  );
  if (!claimed) return false;

  try {
    const outcome = await r.sendEmail(settings.business_id, {
      toEmail: to,
      subject: mail.subject,
      bodyText: mail.body
    });
    if (!outcome.ok) {
      await recordSendFailure(settings, prospect, r, mail.stamp, outcome.detail);
      return false;
    }
    await r.recordEmailLog(r.db, {
      businessId: settings.business_id,
      to,
      // The provider does not report which address it sent from, so the log
      // carries who signed the mail: the configured sender, else the business.
      from: settings.sender_name?.trim() || tenant.name,
      subject: mail.subject,
      body: mail.body,
      providerMessageId: outcome.messageId
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSendFailure(settings, prospect, r, mail.stamp, message.slice(0, 300));
    return false;
  }
}

/**
 * Undo the optimistic claim, and undo the RIGHT one.
 *
 * A failed FIRST pitch clears `sent_at` and marks the row failed: a row left
 * stamped would count against the daily cap and read as outreach that never
 * happened, which is the drafted-versus-sent confusion this ledger exists to
 * avoid.
 *
 * A failed FOLLOW-UP is a different situation, and treating it like the first
 * case corrupts the ledger: the original pitch really did go out, so marking
 * the row failed and clearing `sent_at` would erase a real send, drop the
 * day's send count, and burn the prospect's one nudge on an email nobody
 * received. Only the nudge stamp is released, which leaves the row exactly as
 * it was before the attempt and lets a later pass retry until the prospect
 * ages out of the follow-up window.
 */
async function recordSendFailure(
  settings: OutreachSettingsRow,
  prospect: OutreachProspectRow,
  r: Resolved,
  stamp: "sent_at" | "nudged_at",
  detail: string
): Promise<void> {
  await patchProspect(
    settings.business_id,
    prospect.id,
    stamp === "sent_at"
      ? { status: "failed", status_detail: detail, sent_at: null }
      : { status_detail: detail, nudged_at: null },
    r.db
  );
}

/**
 * Hand the contacted prospect to the tenant's own AiFlow: filing, tagging, the
 * owner brief, and whatever else the owner added. Best-effort by contract, and
 * deliberately AFTER the send: the mail is what matters, and a tenant with no
 * outreach flow installed still gets working outreach.
 */
async function handOffToFlow(
  settings: OutreachSettingsRow,
  prospect: OutreachProspectRow,
  r: Resolved,
  result: OutreachSweepResult,
  mail: { email: string; subject: string }
): Promise<void> {
  try {
    if ((await r.countFlows(settings.business_id, r.db)) === 0) {
      result.notes.push({
        businessId: settings.business_id,
        note: "no webhook flow enabled, so the prospect was emailed but not filed"
      });
      return;
    }
    await r.processFlowEvent(
      settings.business_id,
      {
        source: PROSPECT_OUTREACH_SOURCE,
        eventId: `outreach:${prospect.id}`,
        data: {
          prospect_name: prospect.business_name,
          prospect_email: mail.email,
          // Places supplies a phone for most prospects but not all, and the
          // flow's filing steps are gated on the extractor's 'none' sentinel.
          prospect_phone: prospect.phone ?? "none",
          prospect_domain: prospect.domain,
          prospect_city: prospect.city,
          prospect_vertical: prospect.vertical,
          pitch_subject: mail.subject
        }
      },
      r.db
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("outreach: flow hand-off failed", {
      businessId: settings.business_id,
      error: message
    });
    result.notes.push({
      businessId: settings.business_id,
      note: `flow hand-off failed: ${message.slice(0, 120)}`
    });
  }
}

/** Everything one business gets in one pass. */
async function sweepBusiness(
  settings: OutreachSettingsRow,
  r: Resolved,
  result: OutreachSweepResult
): Promise<void> {
  const resolved = await resolveTenant(settings, r);
  if ("missing" in resolved) {
    result.notes.push({ businessId: settings.business_id, note: resolved.missing });
    return;
  }
  if (discoveryDueToday(settings.last_discovery_at, r.now)) {
    await discoverForBusiness(settings, r, result);
  }
  await draftForBusiness(settings, resolved.tenant, r, result);
  if (settings.mode !== "auto") return;
  // One window check for both outbound phases: a nudge is cold mail too.
  if (
    !isWithinSendWindow(
      r.now,
      resolved.timeZone,
      settings.send_window_start_hour,
      settings.send_window_end_hour
    )
  ) {
    result.notes.push({ businessId: settings.business_id, note: "outside the send window" });
    return;
  }
  // ONE allowance for the day, shared by first pitches and follow-ups: a nudge
  // is a cold email too, so both have to count against the tenant's limit.
  const dayStart = utcDayStartIso(r.now);
  const [sentToday, nudgedToday] = await Promise.all([
    countProspectsSentSince(settings.business_id, dayStart, r.db),
    countProspectsNudgedSince(settings.business_id, dayStart, r.db)
  ]);
  const allowance = settings.daily_cap - sentToday - nudgedToday;
  if (allowance <= 0) {
    result.notes.push({ businessId: settings.business_id, note: "daily cap reached" });
    return;
  }
  const justSent = await sendForBusiness(settings, resolved.tenant, r, result, allowance);
  const leftForNudges = Math.min(allowance - justSent, NUDGE_BATCH);
  if (leftForNudges <= 0) return;
  await nudgeForBusiness(settings, resolved.tenant, r, result, leftForNudges);
}

/**
 * One sweep pass over every business with Prospecting switched on. Per-business
 * failures are collected and the pass continues, so one tenant's expired Places
 * key cannot stop everyone else's outreach.
 */
export async function processOutreachSweep(
  deps: OutreachSweepDeps = {}
): Promise<OutreachSweepResult> {
  const r = await resolveDeps(deps);
  const result: OutreachSweepResult = {
    businesses: 0,
    discovered: 0,
    drafted: 0,
    sent: 0,
    nudged: 0,
    skipped: 0,
    notes: [],
    errors: []
  };

  const active = await listActiveOutreachSettings(r.db);
  for (const settings of active) {
    result.businesses += 1;
    try {
      await sweepBusiness(settings, r, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ businessId: settings.business_id, message });
      logger.warn("outreach-sweep: business failed; continuing", {
        businessId: settings.business_id,
        error: message
      });
      await recordSystemLog(
        {
          businessId: settings.business_id,
          source: "aiflow",
          level: "error",
          event: "outreach_sweep_failed",
          message: `Prospecting sweep failed: ${message}`,
          payload: { mode: settings.mode }
        },
        r.db
      ).catch(() => {
        // A logging failure must never mask the failure it was logging.
      });
    }
  }
  return result;
}
