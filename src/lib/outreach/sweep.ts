/**
 * Prospecting: the sweep. One pass over every business the feature is on for.
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
import {
  placesQueriesPerDayForTier,
  postalAddressRequiredForTier,
  prospectingAllowedForTier
} from "@/lib/plans/prospecting";
import { outreachSchedulingLink } from "@/lib/booking-page/prompt-line";
import {
  sendFromMailboxConnection,
  sendFromOwnerMailbox,
  type OwnerMailboxSendResult
} from "@/lib/email/owner-mailbox";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import {
  isEmailProviderConfigKey,
  providerFromKey,
  resolveEmailConnection
} from "@/lib/voice-tools/connections";
import { rememberSentThread } from "@/lib/email-coworker/threads";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { PROSPECT_OUTREACH_SOURCE } from "@/lib/ai-flows/templates";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { recordSystemLog } from "@/lib/db/system-logs";
import { fireLifecycleStage } from "@/lib/pipelines/lifecycle-hooks";
import { findEngagedProspects } from "./engagement";
import { logger } from "@/lib/logger";
import {
  claimDiscoveryRun,
  claimProspectNudge,
  countProspectsNudgedSince,
  countProspectsSentSince,
  countProspectsByStatus,
  countProspectsToRewrite,
  listProspectsContactedSince,
  existingProspectDomains,
  getOutreachSettings,
  getProspect,
  insertProspects,
  listActiveOutreachSettings,
  OUTREACH_ACTIVE_PAGE_SIZE,
  listProspectsByStatus,
  listProspectsDueForNudge,
  listProspectsToProbe,
  listProspectsToRewrite,
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
  rotationWindow,
  searchPlaces
} from "./discover";
import { hoursFindings, mergeHoursFindings, probeSite } from "./probe";
import {
  assembleBody,
  composePitch,
  isPitchable,
  leadFinding,
  pitchParagraphs,
  polishParagraphs,
  splitParagraphs,
  type PitchTenant
} from "./compose";
import { buildOutreachUnsubscribeUrl, isWithinSendWindow, utcDayStartIso } from "./compliance";

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

/**
 * Pages of active businesses one pass will walk. A safety rail against a
 * pathological read, not a product limit: at the page size this covers ten
 * thousand tenants with the feature switched on.
 */
export const MAX_ACTIVE_PAGES = 50;

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
  sendFromConnectionImpl?: typeof sendFromMailboxConnection;
  getMailboxConnectionImpl?: typeof getWorkspaceOAuthConnection;
  resolveEmailConnectionImpl?: typeof resolveEmailConnection;
  rememberThreadImpl?: typeof rememberSentThread;
  getBusinessImpl?: typeof getBusiness;
  schedulingLinkImpl?: typeof outreachSchedulingLink;
  processFlowEventImpl?: typeof processWebhookFlowEvent;
  recordEmailLogImpl?: typeof recordOutreachEmailLog;
  fireLifecycleStageImpl?: typeof fireLifecycleStage;
  findEngagedImpl?: typeof findEngagedProspects;
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
  sendFromConnection: typeof sendFromMailboxConnection;
  getMailboxConnection: typeof getWorkspaceOAuthConnection;
  resolveEmailConnection: typeof resolveEmailConnection;
  rememberThread: typeof rememberSentThread;
  getBusiness: typeof getBusiness;
  schedulingLink: typeof outreachSchedulingLink;
  processFlowEvent: typeof processWebhookFlowEvent;
  recordEmailLog: typeof recordOutreachEmailLog;
  fireLifecycleStage: typeof fireLifecycleStage;
  findEngaged: typeof findEngagedProspects;
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
    sendFromConnection: deps.sendFromConnectionImpl ?? sendFromMailboxConnection,
    getMailboxConnection: deps.getMailboxConnectionImpl ?? getWorkspaceOAuthConnection,
    resolveEmailConnection: deps.resolveEmailConnectionImpl ?? resolveEmailConnection,
    rememberThread: deps.rememberThreadImpl ?? rememberSentThread,
    getBusiness: deps.getBusinessImpl ?? getBusiness,
    schedulingLink: deps.schedulingLinkImpl ?? outreachSchedulingLink,
    processFlowEvent: deps.processFlowEventImpl ?? processWebhookFlowEvent,
    recordEmailLog: deps.recordEmailLogImpl ?? recordOutreachEmailLog,
    fireLifecycleStage: deps.fireLifecycleStageImpl ?? fireLifecycleStage,
    findEngaged: deps.findEngagedImpl ?? findEngagedProspects
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
): Promise<
  | { tenant: PitchTenant; timeZone: string | null; placesQueriesPerDay: number }
  | { missing: string; blockedBy: "tier" | "config" }
> {
  const business = await r.getBusiness(settings.business_id, r.db);
  if (!business) return { missing: "business row is gone", blockedBy: "config" };
  // Downgrade after switching Prospecting on: leave settings alone, but stop
  // spending Places/AI/Resend until they upgrade again. blockedBy carries the
  // classification so callers never have to infer it from the note's wording.
  if (!prospectingAllowedForTier(business.tier)) {
    return { missing: "prospecting requires the Standard plan", blockedBy: "tier" };
  }
  // The footer address: what the owner typed into the Prospecting panel, then
  // the business profile address, but the FALLBACK BELONGS TO THE WAIVER, not
  // to everyone. A tier that must type one is blocked without it even when a
  // profile address exists, for three reasons that are really one: the panel's
  // blocker (describeBlockers) names the typed field, the DB check constraint
  // requires the typed field, and a page that says outreach cannot run while
  // the sweep sends anyway is the worst of the available behaviors. It also
  // catches the downgrade: Enterprise to Standard leaves a stale
  // postal_address_exempt behind, and the tier is re-read here, so those sends
  // stop instead of quietly riding the profile address.
  const typedAddress = settings.postal_address?.trim() ?? "";
  const exempt = !postalAddressRequiredForTier(business.tier);
  const postalAddress = typedAddress || (exempt ? (business.address ?? "").trim() : "");
  if (!postalAddress && !exempt) {
    return { missing: "no postal address configured", blockedBy: "config" };
  }
  const valueProp = settings.value_prop?.trim() ?? "";
  if (!valueProp) return { missing: "no value proposition configured", blockedBy: "config" };
  // The outreach-specific link: straight to the meeting the owner named,
  // rather than the page's "what would you like to book?" chooser.
  const link = await r
    .schedulingLink(settings.business_id, settings.booking_meeting_type_id)
    .catch(() => null);
  return {
    tenant: {
      name: business.name.trim(),
      valueProp,
      website: (business as { website_url?: string | null }).website_url?.trim() || null,
      bookingUrl: link?.url ?? null,
      senderName: settings.sender_name?.trim() || null,
      postalAddress
    },
    timeZone: business.timezone ?? null,
    // The tier sets how many paid Places queries today's discovery may buy,
    // resolved here because this is the one place the business row is read.
    placesQueriesPerDay: placesQueriesPerDayForTier(business.tier)
  };
}

/** Phase 1: buy the day's Places queries and file what comes back. */
async function discoverForBusiness(
  settings: OutreachSettingsRow,
  r: Resolved,
  result: OutreachSweepResult,
  queriesPerDay: number
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
  // Claim the day BEFORE the queries, in one atomic write. These calls cost
  // money twice over if this is wrong: a crash halfway through must not let the
  // next tick re-buy the same searches, and two overlapping passes must not
  // both buy them either. At-most-once beats at-least-once when the retry is
  // billable, so the loser of the claim simply skips discovery this pass.
  const claimed = await claimDiscoveryRun(
    settings.business_id,
    r.now.toISOString(),
    utcDayStartIso(r.now),
    r.db
  );
  if (!claimed) return;
  for (const slot of rotationWindow(rotation, dayIndexFor(r.now), queriesPerDay)) {
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
        // Null rather than blank when Places had no number, so "has a phone"
        // stays a single question downstream.
        phone: c.phone || null,
        vertical: c.vertical,
        city: c.city,
        // Free with the query we already pay for: hours ground the after-hours
        // finding, and the review count orders which prospects get probed.
        google_hours: c.openingHours,
        rating: c.rating,
        review_count: c.reviewCount
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
  const pending = await listProspectsToProbe(settings.business_id, budget, r.db);

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
    // Google's opening hours beat a regex over the prospect's markup, which
    // finds nothing on any site that renders its hours in JavaScript. The
    // site's own findings still supply everything Google cannot see.
    const findings = mergeHoursFindings(probed.findings, hoursFindings(prospect.google_hours));
    if (!isPitchable(findings)) {
      await retire("nothing checkable to say about their site");
      continue;
    }
    // Claiming the address can lose to the partial unique index when another
    // prospect of this business already fronts it (a shared owner, or one
    // agency running both sites). That is a duplicate to retire, not an error.
    const claimed = await patchProspect(
      settings.business_id,
      prospect.id,
      { email: probed.email, findings },
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
      findings
    };
    // isPitchable already proved a lead finding with an honest opening exists,
    // so composePitch cannot come back empty here.
    const deterministic = composePitch(
      tenant,
      pitchProspect,
      unsubscribeUrl
    ) as { subject: string; body: string };
    const lead = leadFinding(findings) as { code: string; detail: string };
    // Polish the middle only, then re-assemble: the footer never reaches a
    // model, so it cannot be reworded away.
    const polished = await r.polish(
      settings.business_id,
      pitchParagraphs(tenant, pitchProspect, lead)
    );
    // Guarded on the row still being `discovered`, not a blind write.
    // A pass takes seconds per prospect (a probe, then a model call), and the
    // owner can retire this whole trade while it runs. An unguarded write would
    // finish composing and move a just-skipped prospect BACK to `drafted`, and
    // in automatic mode that draft then goes out: the trade the owner called
    // off gets emailed anyway. Losing the claim means somebody else moved the
    // row on purpose, so the compose is dropped rather than counted.
    const drafted = await transitionProspect(
      settings.business_id,
      prospect.id,
      "discovered",
      {
        status: "drafted",
        status_detail: null,
        drafted_at: r.now.toISOString(),
        pitch_subject: deterministic.subject,
        // Stored apart from the body so the owner can edit the writing without
        // ever holding the footer: see editProspectDraft.
        pitch_paragraphs: polished.join("\n\n"),
        pitch_body: assembleBody(tenant, polished, unsubscribeUrl)
      },
      r.db
    );
    if (!drafted) {
      result.notes.push({
        businessId: settings.business_id,
        note: `${prospect.domain}: retired while it was being drafted`
      });
      continue;
    }
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
      stamp: "sent_at"
    });
    if (!sent) continue;
    result.sent += 1;
    sentThisPass += 1;
    await handOffToFlow(settings, prospect, r, result, { email: to, subject });
  }
  return sentThisPass;
}

/**
 * How far back the reconcile phase looks. Long enough to cover a send whose
 * contact was filed late (or not at all, until the owner switched their
 * outreach flow on), short enough that the work stays a handful of indexed
 * reads per pass.
 */
const CONTACTED_RECONCILE_DAYS = 3;

/** Ceiling on one reconcile pass, so a busy tenant cannot stall the sweep. */
const CONTACTED_RECONCILE_LIMIT = 100;

/**
 * How long a prospect may have no contact row before we stop waiting for one.
 *
 * The filing race is about a minute (a 00:55:59 send produced a 00:57:02
 * contact), so half an hour is generous. Past it, "no contact" is not a race,
 * it is an answer: the tenant's outreach flow is off, or filing failed, or the
 * number will not normalize. Those rows must still be stamped, or they collect
 * at the head of an oldest-first, capped queue and starve every prospect behind
 * them, whose contacts DO exist, until those age out of the window in New Lead.
 */
const CONTACTED_RACE_GRACE_MS = 30 * 60 * 1000;

/**
 * Move emailed prospects to the Contacted stage on the owner's board.
 *
 * Why this is a separate phase and not part of the send. The board is keyed on
 * CONTACTS, and a cold-emailed prospect has none at the moment the mail leaves:
 * the outreach flow files them asynchronously, about a minute later (measured:
 * a send at 00:55:59 produced a contact at 00:57:02). Firing the stage inside
 * the send would find nothing to tag, and the flow would then file them as
 * "New Lead", where they would sit next to leads nobody has touched while the
 * Contacted column read zero.
 *
 * So it runs on the NEXT pass, over everything emailed recently, and is safe to
 * repeat: `applyLifecycleStage` is forward-only, so a prospect already at
 * Contacted or beyond costs one read and no write, and one who has since
 * replied is never dragged back. It also backfills, which is what makes this a
 * fix for the sends that already happened rather than only for future ones.
 *
 * Tenants without a Contacted stage get nothing, by the same rule: the stage
 * has to exist, because a stage IS a tag and inventing one writes junk.
 */
async function reconcileContactedForBusiness(
  settings: OutreachSettingsRow,
  r: Resolved,
  result: OutreachSweepResult
): Promise<void> {
  const since = new Date(
    r.now.getTime() - CONTACTED_RECONCILE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  // The WHOLE phase is wrapped, not just the per-prospect move. It runs before
  // the send, so anything that escapes stops the mail, and the list read is as
  // able to throw as the move is. The board is cosmetic; the mail is the job.
  try {
    const contacted = await listProspectsContactedSince(
      settings.business_id,
      since,
      CONTACTED_RECONCILE_LIMIT,
      r.db
    );
    for (const prospect of contacted) {
      const outcome = await r.fireLifecycleStage(
        settings.business_id,
        prospect.phone,
        "contacted",
        { dedupeSuffix: prospect.id }
      );
      // Every outcome except "no contact" is final (moved, already past it, no
      // such stage, a teammate, the feature switched off), so stamping keeps
      // the row out of a queue it would otherwise clog.
      //
      // "No contact" is the one that might still be the filing race, and it is
      // only retried while it plausibly IS one. Left null forever it would be
      // worse than not stamping at all: a tenant with their outreach flow off
      // never files ANY contact, so every one of their sends would pile up at
      // the head of an oldest-first capped queue and starve the prospects
      // behind them whose contacts do exist.
      const stillRacing =
        outcome === "no_contact" &&
        (prospect.sent_at ?? "") > new Date(r.now.getTime() - CONTACTED_RACE_GRACE_MS).toISOString();
      if (stillRacing) continue;
      await patchProspect(
        settings.business_id,
        prospect.id,
        { contacted_stage_at: r.now.toISOString() },
        r.db
      );
    }
  } catch (err) {
    result.notes.push({
      businessId: settings.business_id,
      note: `could not move emailed prospects to Contacted: ${
        err instanceof Error ? err.message : String(err)
      }`.slice(0, 200)
    });
  }
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
  // Silence is what schedules this mail, and `replied_at` only ever hears
  // EMAIL. Ask the other two ways a prospect can have answered (they booked
  // from the link the pitch carried, or their card has moved past Contacted)
  // before writing to somebody who has already met us. Checked BEFORE the
  // claim so the common case never claims and undoes.
  const engagement = await r.findEngaged(settings.business_id, due, r.db);
  if (engagement.readFailed) {
    // Fail-safe: suppress rather than risk mailing a customer. Nothing is
    // stamped, so the same prospects are due again on the next pass; only a
    // persistent failure stops follow-ups, and this note is how that shows.
    result.notes.push({
      businessId: settings.business_id,
      note: "held this pass's follow-ups: could not confirm whether these prospects had already booked or replied"
    });
    return;
  }

  for (const prospect of due) {
    const to = prospect.email;
    // Same reasoning as the send phase: no address means nothing to do, and
    // silently "succeeding" would burn this prospect's one follow-up.
    if (!to) continue;
    if (engagement.engaged.has(prospect.id)) {
      // RETIRE the row, do not just skip it. The due query is oldest-first
      // and capped at NUDGE_BATCH, so a handful of booked leads left at
      // `status = 'sent'` would win every slot on every pass and starve the
      // silent prospects behind them until those aged out of the window
      // unnudged. That is the same starvation `reconcileContactedForBusiness`
      // documents a few functions up, and leaving it unstamped walked
      // straight back into it (Bugbot, PR #1571).
      //
      // Stamped as `replied` rather than `nudged`, because that is what
      // happened: this ledger's "replied" means the prospect ANSWERED the
      // outreach, and `noteProspectReply` writes the same pair for the email
      // case. Booking a call is an answer. `nudged_at` stays null, so the one
      // follow-up they are owed is still theirs if the owner ever wants it.
      await patchProspect(
        settings.business_id,
        prospect.id,
        { status: "replied", replied_at: r.now.toISOString() },
        r.db
      );
      result.skipped += 1;
      continue;
    }
    const unsubscribeUrl = buildOutreachUnsubscribeUrl(
      r.appUrl,
      settings.business_id,
      prospect.id
    );
    const body = assembleBody(
      tenant,
      [
        `Hi ${prospect.business_name.trim() || "there"},`,
        "I wrote last week about what I noticed when I looked you up. If it is not useful, no problem at all and I will leave it there.",
        "If it is, I am happy to walk you through it."
      ],
      unsubscribeUrl
    );
    // The nudge rides the ORIGINAL subject so it reads as the same conversation.
    const sent = await deliverPitch(settings, tenant, prospect, r, {
      to,
      subject: prospect.pitch_subject?.trim() || "Following up",
      body,
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
    stamp: "sent_at" | "nudged_at";
  }
): Promise<boolean> {
  const to = mail.to;
  // Two different atomic claims, because the two sends have different
  // invariants. A first pitch is guarded on the STATUS moving (drafted to
  // sent), which no second pass can repeat. A nudge leaves the status alone,
  // so the guard has to be "nudged_at is still null", checked inside the same
  // UPDATE that sets it, or two overlapping passes both send the one follow-up
  // a prospect ever gets.
  const claimed =
    mail.stamp === "sent_at"
      ? await transitionProspect(
          settings.business_id,
          prospect.id,
          "drafted",
          { status: "sent", sent_at: r.now.toISOString() },
          r.db
        )
      : await claimProspectNudge(settings.business_id, prospect.id, r.now.toISOString(), r.db);
  if (!claimed) return false;

  // LAST-MILE SUPPRESSION RE-CHECK, immediately before the provider call and
  // after the claim. The claim is guarded on status, so an opt-out that lands
  // BEFORE it loses cleanly; one that lands just after it would otherwise be
  // ignored, and the mail would go to somebody who has already asked to stop.
  // Same shape as the campaign sweep's re-check, and the same reason.
  //
  // This narrows the window rather than closing it: an opt-out arriving in the
  // milliseconds between this read and the provider accepting the message
  // cannot be caught without a transaction spanning an external API. What it
  // does guarantee is that no LATER send follows, and that the ledger does not
  // claim a send that was abandoned here.
  const current = await getProspect(settings.business_id, prospect.id, r.db);
  if (!current) {
    // The row went away between the claim and this read (an owner deletion, a
    // cascade). The undo writes to nothing in that case, and it is issued
    // anyway so that EVERY abort path undoes its own claim: an invariant that
    // holds by construction beats one that holds because of an argument about
    // which reads can return null.
    await patchProspect(
      settings.business_id,
      prospect.id,
      mail.stamp === "sent_at" ? { sent_at: null, status: "drafted" } : { nudged_at: null },
      r.db
    );
    return false;
  }
  const optedOut = current.status === "unsubscribed";
  const answered = current.replied_at !== null;
  if (optedOut || answered) {
    // Undo the claim to the state the abort reason implies, not just the
    // stamp. Clearing `sent_at` alone could leave a row reading `sent` with no
    // send behind it: invisible to the drafted queue, unsendable, and counted
    // as outreach by the funnel.
    await patchProspect(
      settings.business_id,
      prospect.id,
      mail.stamp === "sent_at"
        ? { sent_at: null, status: optedOut ? "unsubscribed" : "replied" }
        : { nudged_at: null },
      r.db
    );
    return false;
  }

  try {
    const outcome = await sendThroughConfiguredMailbox(settings, r, {
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
      // The send result reports the mailbox address the mail left from; only
      // a legacy connection with no address in its metadata falls back to who
      // signed the mail: the configured sender, else the business.
      from: outcome.fromEmail ?? (settings.sender_name?.trim() || tenant.name),
      subject: mail.subject,
      body: mail.body,
      providerMessageId: outcome.messageId
    });
    // Hand the thread to the email coworker, which is what lets a prospect's
    // REPLY be read at all: it polls owned threads, answers in-thread, can book
    // the call, and marks this prospect replied so no follow-up talks over
    // them. Gmail returns the conversation id on send; Graph returns no body,
    // so Microsoft tenants send fine and simply get no autonomous follow-ups
    // (the same limitation the email coworker documents).
    if (outcome.threadId) {
      await r.rememberThread(
        {
          businessId: settings.business_id,
          provider: outcome.provider,
          threadId: outcome.threadId,
          subject: mail.subject,
          correspondentEmail: to,
          sentMessageRef: outcome.messageId
        },
        r.db
      );
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSendFailure(settings, prospect, r, mail.stamp, message.slice(0, 300));
    return false;
  }
}

/**
 * Is there a mailbox to send from at all, before anything is claimed?
 *
 * Without this the answer arrived one prospect at a time, and destructively: a
 * tenant with no connected mailbox (or a pinned one since disconnected) had
 * every draft claimed, attempted, and stamped `failed`, which is terminal. A
 * whole queue could burn down over a few passes, and the owner's only clue was
 * a funnel where drafted fell and failed rose. A missing mailbox is a
 * configuration problem, not a per-prospect delivery failure, so it stops the
 * pass with a note and leaves the drafts exactly where they are.
 *
 * Checked with the same two lookups the send path itself uses, so the two
 * cannot disagree about whether a mailbox is usable.
 */
async function outreachMailboxMissing(
  settings: OutreachSettingsRow,
  r: Resolved
): Promise<string | null> {
  const chosen = settings.from_connection_id?.trim();
  if (!chosen) {
    const conn = await r.resolveEmailConnection(settings.business_id);
    return conn ? null : "no mailbox connected to send from";
  }
  const row = await r.getMailboxConnection(settings.business_id, chosen);
  if (!row || !isEmailProviderConfigKey(row.provider_config_key)) {
    return "the mailbox chosen for outreach is no longer connected";
  }
  return null;
}

/**
 * Send through the mailbox the owner PICKED for outreach when they picked one,
 * and the business's default email connection otherwise.
 *
 * A tenant with several connected mailboxes (a personal one and a shared
 * sales@, say) cares which address a cold email comes from: it is the address
 * replies land in and the domain whose reputation is at stake. Storing that
 * choice and then ignoring it would silently send from the wrong place.
 */
async function sendThroughConfiguredMailbox(
  settings: OutreachSettingsRow,
  r: Resolved,
  args: { toEmail: string; subject: string; bodyText: string }
): Promise<OwnerMailboxSendResult> {
  const chosen = settings.from_connection_id?.trim();
  if (!chosen) return r.sendEmail(settings.business_id, args);
  const row = await r.getMailboxConnection(settings.business_id, chosen);
  // A deleted or reconnected mailbox leaves a stale id. Falling back to the
  // default would send from an address the owner did not choose, so this fails
  // instead and the ledger records why.
  if (!row || !isEmailProviderConfigKey(row.provider_config_key)) {
    return { ok: false, detail: "email_not_connected" };
  }
  return r.sendFromConnection(
    settings.business_id,
    {
      provider: providerFromKey(row.provider_config_key),
      providerConfigKey: row.provider_config_key,
      connectionId: row.connection_id
    },
    args
  );
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
    const outcome = await r.processFlowEvent(
      settings.business_id,
      {
        source: PROSPECT_OUTREACH_SOURCE,
        eventId: `outreach:${prospect.id}`,
        data: {
          prospect_name: prospect.business_name,
          prospect_email: mail.email,
          // Places supplies a phone for most prospects but not all, and the
          // flow's filing steps are gated on the extractor's literal 'none'
          // sentinel. A BLANK is the trap here: it is neither null nor 'none',
          // so it would sail through the gate and file a contact with no phone
          // into a phone-keyed CRM.
          prospect_phone: prospect.phone?.trim() || "none",
          prospect_domain: prospect.domain,
          prospect_city: prospect.city,
          prospect_vertical: prospect.vertical,
          pitch_subject: mail.subject
        }
      },
      r.db,
      // Platform-generated hand-off after our own outreach send, not an
      // external webhook: the Standard-tier webhook gate must not block it.
      { origin: "internal" }
    );
    // Ask the MATCHER, not a flow count: a tenant can have other webhook flows
    // enabled while the prospect follow-through one is missing or switched off,
    // and then nothing files the prospect and nobody is told. `flowsMatched`
    // counts flows whose conditions actually matched this event, so zero means
    // exactly "no flow handled it". A positive match with nothing enqueued is a
    // redelivery of an event already handled, which is fine.
    if (outcome.flowsMatched === 0) {
      result.notes.push({
        businessId: settings.business_id,
        note: "no flow matched, so the prospect was emailed but not filed"
      });
    }
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

export type SendNowResult =
  | { ok: true; notes: string[] }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_drafted"
        | "cap_reached"
        | "not_configured"
        | "tier_blocked"
        | "no_mailbox"
        | "send_failed";
      detail?: string;
    };

/**
 * Send ONE drafted prospect right now, because the owner pressed Send in manual
 * mode. Shares the whole send path with the sweep (same claim, same mailbox,
 * same email_log write, same flow hand-off), so a manual send and an automatic
 * one are the same event with the same audit trail.
 *
 * The send WINDOW is deliberately not enforced: the owner is choosing this
 * moment. The daily cap still is, because deliverability is physics rather than
 * policy, and a burst is what gets a sending domain filtered.
 */
export async function sendProspectNow(
  businessId: string,
  prospectId: string,
  deps: OutreachSweepDeps = {}
): Promise<SendNowResult> {
  const r = await resolveDeps(deps);
  const settings = await getOutreachSettings(businessId, r.db);
  if (!settings) return { ok: false, reason: "not_configured" };
  const resolved = await resolveTenant(settings, r);
  if ("missing" in resolved) {
    // Classified by the discriminant, not by matching the note's copy: a
    // wording tweak must never silently turn this 403 into "finish setting
    // up Prospecting first".
    if (resolved.blockedBy === "tier") {
      return { ok: false, reason: "tier_blocked", detail: resolved.missing };
    }
    return { ok: false, reason: "not_configured", detail: resolved.missing };
  }

  const prospect = await getProspect(businessId, prospectId, r.db);
  if (!prospect) return { ok: false, reason: "not_found" };
  if (prospect.status !== "drafted") return { ok: false, reason: "not_drafted" };
  const to = prospect.email;
  const subject = prospect.pitch_subject?.trim();
  const body = prospect.pitch_body?.trim();
  if (!to || !subject || !body) {
    // Marked failed, exactly as the automatic path does. Returning the reason
    // without recording it would leave a broken draft sitting in the queue for
    // the owner to press Send on again, and again.
    await recordSendFailure(
      settings,
      prospect,
      r,
      "sent_at",
      "draft is missing its address or pitch text"
    );
    return { ok: false, reason: "not_drafted", detail: "the draft has no address or pitch text" };
  }

  // Same gate as the sweep, and for the same reason: without it one press on a
  // tenant with no mailbox marks the draft `failed`, which is terminal, and the
  // owner loses the draft as well as the send.
  const noMailbox = await outreachMailboxMissing(settings, r);
  if (noMailbox) return { ok: false, reason: "no_mailbox", detail: noMailbox };

  const dayStart = utcDayStartIso(r.now);
  const [sentToday, nudgedToday] = await Promise.all([
    countProspectsSentSince(businessId, dayStart, r.db),
    countProspectsNudgedSince(businessId, dayStart, r.db)
  ]);
  if (settings.daily_cap - sentToday - nudgedToday <= 0) {
    return { ok: false, reason: "cap_reached" };
  }

  const result: OutreachSweepResult = {
    businesses: 1,
    discovered: 0,
    drafted: 0,
    sent: 0,
    nudged: 0,
    skipped: 0,
    notes: [],
    errors: []
  };
  const sent = await deliverPitch(settings, resolved.tenant, prospect, r, {
    to,
    subject,
    body,
    stamp: "sent_at"
  });
  if (!sent) return { ok: false, reason: "send_failed" };
  await handOffToFlow(settings, prospect, r, result, { email: to, subject });
  return { ok: true, notes: result.notes.map((n) => n.note) };
}

/**
 * Drafts sent per request when the owner presses Send all.
 *
 * Each one is a provider round-trip plus a flow hand-off, so the work is cut
 * into slices and the caller loops, exactly like the bulk rewrite. The daily
 * cap is usually smaller than one slice anyway; the batching matters for a
 * tenant whose cap is set high.
 */
export const SEND_NOW_BATCH = 10;

export type SendAllResult =
  | {
      ok: true;
      sent: number;
      /** Drafts still waiting after this batch. */
      remaining: number;
      /** How many more may go out today. Zero means the cap is spent. */
      allowanceLeft: number;
      notes: string[];
    }
  | {
      ok: false;
      reason: "not_configured" | "tier_blocked" | "no_mailbox";
      detail?: string;
    };

/**
 * Send the waiting drafts now, up to what today's cap still allows.
 *
 * The same send path as everything else: same claim, same suppression
 * re-check, same email_log row, same flow hand-off. Two things differ from the
 * sweep, and both are deliberate.
 *
 * The SEND WINDOW is not enforced, for the reason the single Send button
 * ignores it too: the owner is choosing this moment. The DAILY CAP is enforced,
 * for the reason it exists: a few hundred cold emails leaving one mailbox in a
 * burst is how a sending domain gets rate limited, and a button that quietly
 * suspended the tenant's own deliverability rule would be doing them harm on
 * request. So "all" means "as many as today allows", the caller is told exactly
 * how many that is before pressing, and the rest stay queued.
 */
export async function sendDraftsNow(
  businessId: string,
  deps: OutreachSweepDeps = {}
): Promise<SendAllResult> {
  const r = await resolveDeps(deps);
  const settings = await getOutreachSettings(businessId, r.db);
  if (!settings) return { ok: false, reason: "not_configured" };
  const resolved = await resolveTenant(settings, r);
  if ("missing" in resolved) {
    return {
      ok: false,
      reason: resolved.blockedBy === "tier" ? "tier_blocked" : "not_configured",
      detail: resolved.missing
    };
  }
  // Before anything is claimed, same as the sweep: a missing mailbox must not
  // be discovered one prospect at a time, stamping each `failed` on the way.
  const noMailbox = await outreachMailboxMissing(settings, r);
  if (noMailbox) return { ok: false, reason: "no_mailbox", detail: noMailbox };

  const dayStart = utcDayStartIso(r.now);
  const [sentToday, nudgedToday] = await Promise.all([
    countProspectsSentSince(businessId, dayStart, r.db),
    countProspectsNudgedSince(businessId, dayStart, r.db)
  ]);
  // One allowance for the day, shared with follow-ups, exactly as the sweep
  // computes it: a nudge is a cold email too.
  const allowance = settings.daily_cap - sentToday - nudgedToday;
  const result: OutreachSweepResult = {
    businesses: 1,
    discovered: 0,
    drafted: 0,
    sent: 0,
    nudged: 0,
    skipped: 0,
    errors: [],
    notes: []
  };
  const sent =
    allowance <= 0
      ? 0
      : await sendForBusiness(
          settings,
          resolved.tenant,
          r,
          result,
          Math.min(allowance, SEND_NOW_BATCH)
        );
  const remaining = await countProspectsByStatus(businessId, "drafted", r.db);
  return {
    ok: true,
    sent,
    remaining,
    allowanceLeft: Math.max(0, allowance - sent),
    notes: result.notes.map((n) => n.note)
  };
}

/** Ceiling on an owner-written pitch, so one paste cannot become an essay. */
export const MAX_EDITED_SUBJECT_CHARS = 200;
export const MAX_EDITED_BODY_CHARS = 4000;

export type DraftUpdateResult =
  | { ok: true; prospect: { pitch_subject: string; pitch_paragraphs: string; pitch_body: string } }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_drafted"
        | "not_configured"
        | "tier_blocked"
        | "empty_text"
        | "too_long"
        | "not_pitchable";
      detail?: string;
    };

/**
 * Everything an owner draft action needs: the tenant identity the footer is
 * built from, the prospect row, and the prospect's own unsubscribe link.
 * Shared by edit and regenerate so both refuse the same things for the same
 * reasons, in the same order the Send button does.
 */
async function loadDraftContext(
  businessId: string,
  prospectId: string,
  r: Resolved
): Promise<
  | { tenant: PitchTenant; prospect: OutreachProspectRow; unsubscribeUrl: string }
  | { failure: DraftUpdateResult }
> {
  const settings = await getOutreachSettings(businessId, r.db);
  if (!settings) return { failure: { ok: false, reason: "not_configured" } };
  const resolved = await resolveTenant(settings, r);
  if ("missing" in resolved) {
    return {
      failure: {
        ok: false,
        reason: resolved.blockedBy === "tier" ? "tier_blocked" : "not_configured",
        detail: resolved.missing
      }
    };
  }
  const prospect = await getProspect(businessId, prospectId, r.db);
  if (!prospect) return { failure: { ok: false, reason: "not_found" } };
  // Only a draft is editable. A sent pitch is a thing that happened, and
  // rewriting the ledger copy of an email already in someone's inbox would
  // make the record disagree with reality.
  if (prospect.status !== "drafted") return { failure: { ok: false, reason: "not_drafted" } };
  return {
    tenant: resolved.tenant,
    prospect,
    unsubscribeUrl: buildOutreachUnsubscribeUrl(r.appUrl, businessId, prospectId)
  };
}

/**
 * The owner rewrote a draft. Their text becomes the PARAGRAPHS; the CTA, the
 * signature, the unsubscribe link, and the postal address are re-assembled
 * around it by `assembleBody`, exactly as they are for a machine-written
 * draft.
 *
 * That split is the whole design. The README's rule for why the send is not a
 * flow step ("a flow step's body is owner-editable copy, so a well-meaning
 * edit could delete the footer") applies just as hard to an edit box on the
 * dashboard, so the edit box never contains the footer in the first place: it
 * holds the middle, and the compliance lines are concatenated after it in code
 * the owner cannot reach.
 *
 * Guarded on the prospect still being a draft, like Send and Skip beside it:
 * the review queue can be minutes stale, and an unguarded write would rewrite
 * the stored copy of a pitch the sweep has already sent.
 */
export async function editProspectDraft(
  businessId: string,
  prospectId: string,
  edit: { subject: string; paragraphs: string },
  deps: OutreachSweepDeps = {}
): Promise<DraftUpdateResult> {
  const subject = edit.subject.trim();
  const text = edit.paragraphs.trim();
  if (!subject || !text) return { ok: false, reason: "empty_text" };
  if (subject.length > MAX_EDITED_SUBJECT_CHARS || text.length > MAX_EDITED_BODY_CHARS) {
    return { ok: false, reason: "too_long" };
  }

  const r = await resolveDeps(deps);
  const context = await loadDraftContext(businessId, prospectId, r);
  if ("failure" in context) return context.failure;

  const paragraphs = splitParagraphs(text);
  const patch = {
    pitch_subject: subject,
    pitch_paragraphs: paragraphs.join("\n\n"),
    pitch_body: assembleBody(context.tenant, paragraphs, context.unsubscribeUrl)
  };
  const saved = await transitionProspect(businessId, prospectId, "drafted", patch, r.db);
  if (!saved) return { ok: false, reason: "not_drafted" };
  return { ok: true, prospect: patch };
}

/**
 * Write the draft again from scratch: the same deterministic pitch the sweep
 * composes, through the same optional tone pass, so a second attempt reads
 * like a different email rather than a rearrangement of the first.
 *
 * It re-composes from the findings ALREADY on the row rather than re-probing
 * the prospect's site. A probe is a network fetch of somebody else's server,
 * and a button an owner can press repeatedly must not turn into one. Anything
 * the owner changed by hand is discarded, which is what "regenerate" means.
 */
export async function regenerateProspectDraft(
  businessId: string,
  prospectId: string,
  deps: OutreachSweepDeps = {}
): Promise<DraftUpdateResult> {
  const r = await resolveDeps(deps);
  const context = await loadDraftContext(businessId, prospectId, r);
  if ("failure" in context) return context.failure;
  return rewriteOneDraft(businessId, context.tenant, context.prospect, r);
}

/**
 * Compose one drafted row again from the findings already on it, then write it.
 *
 * The shared middle of Write it again, whether the owner pressed it on a single
 * draft or on the whole queue. Kept as one function so a bulk rewrite cannot
 * drift into producing a different email from the single-draft button: the
 * subject, the paragraphs, the tone pass, and the footer are assembled here
 * once.
 */
async function rewriteOneDraft(
  businessId: string,
  tenant: PitchTenant,
  prospect: OutreachProspectRow,
  r: Resolved
): Promise<DraftUpdateResult> {
  const unsubscribeUrl = buildOutreachUnsubscribeUrl(r.appUrl, businessId, prospect.id);
  const findings = prospect.findings ?? [];
  // The row was drafted, so it was pitchable once. Re-checked anyway: the
  // finding vocabulary can change under a stored row, and composePitch coming
  // back null here would otherwise be an unexplained failure.
  if (!isPitchable(findings)) return { ok: false, reason: "not_pitchable" };
  const pitchProspect = {
    businessName: prospect.business_name,
    city: prospect.city,
    findings
  };
  const deterministic = composePitch(tenant, pitchProspect, unsubscribeUrl) as {
    subject: string;
    body: string;
  };
  const lead = leadFinding(findings) as { code: string; detail: string };
  const polished = await r.polish(businessId, pitchParagraphs(tenant, pitchProspect, lead));
  const patch = {
    pitch_subject: deterministic.subject,
    pitch_paragraphs: polished.join("\n\n"),
    pitch_body: assembleBody(tenant, polished, unsubscribeUrl)
  };
  const saved = await transitionProspect(businessId, prospect.id, "drafted", patch, r.db);
  if (!saved) return { ok: false, reason: "not_drafted" };
  return { ok: true, prospect: patch };
}

/**
 * Drafts rewritten per request. One rewrite is one Gemini tone pass of about a
 * second, so a batch is sized to finish well inside the route's time budget and
 * the caller loops until `remaining` reaches zero. A single long request would
 * be the wrong shape here: a tenant with hundreds of waiting drafts would sit
 * behind one response until the edge timed it out and lose the work already
 * done.
 */
export const REWRITE_BATCH_SIZE = 20;

export type RewriteAllResult =
  | {
      ok: true;
      /** Cursor for the next batch. Echo it back to keep one run one pass. */
      startedAt: string;
      rewritten: number;
      /** Reached, but left alone: nothing checkable left to say, or no longer a draft. */
      skipped: number;
      remaining: number;
    }
  | { ok: false; reason: "not_configured" | "tier_blocked"; detail?: string };

/**
 * Write every waiting draft again, one batch per call.
 *
 * The button this serves exists because the drafts outlive the settings that
 * produced them. Change the offer, the sender name, or the footer address and
 * the queue still holds the old wording, however many hundreds of drafts deep
 * it is, with no way to refresh them short of pressing Write it again on each
 * one. This re-composes them from the findings already stored, so no prospect's
 * site is fetched again.
 *
 * Anything the owner edited by hand is replaced, exactly as the single-draft
 * button replaces it. The caller warns before spending that.
 *
 * `since` is the run's cursor: the first call leaves it out and gets one back,
 * every later call passes it. A draft this run has already rewritten has a
 * newer `updated_at` than the cursor, so it drops out of the next batch without
 * anything having to remember it.
 */
export async function rewriteAllProspectDrafts(
  businessId: string,
  options: { since?: string } = {},
  deps: OutreachSweepDeps = {}
): Promise<RewriteAllResult> {
  const r = await resolveDeps(deps);
  const settings = await getOutreachSettings(businessId, r.db);
  if (!settings) return { ok: false, reason: "not_configured" };
  const resolved = await resolveTenant(settings, r);
  if ("missing" in resolved) {
    return {
      ok: false,
      reason: resolved.blockedBy === "tier" ? "tier_blocked" : "not_configured",
      detail: resolved.missing
    };
  }

  const startedAt = options.since ?? r.now.toISOString();
  const batch = await listProspectsToRewrite(businessId, startedAt, REWRITE_BATCH_SIZE, r.db);
  let rewritten = 0;
  let skipped = 0;
  for (const prospect of batch) {
    const result = await rewriteOneDraft(businessId, resolved.tenant, prospect, r);
    if (result.ok) {
      rewritten += 1;
      continue;
    }
    skipped += 1;
    // Nothing was written, so the row still sits before the cursor and the next
    // batch would read it again forever. Stamping `updated_at` moves it past,
    // and the stamp rides the same drafted-only guard so a prospect the sweep
    // sent mid-run is left alone instead of being touched after the fact.
    if (result.reason === "not_pitchable") {
      await transitionProspect(businessId, prospect.id, "drafted", {}, r.db);
    }
  }
  const remaining = await countProspectsToRewrite(businessId, startedAt, r.db);
  return { ok: true, startedAt, rewritten, skipped, remaining };
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
  await discoverForBusiness(settings, r, result, resolved.placesQueriesPerDay);
  await draftForBusiness(settings, resolved.tenant, r, result);
  // Before the auto-only gate: a manual-mode tenant sends with the Send button
  // and their board deserves the same truth. This phase reads and tags, it
  // never sends, so it is safe outside the window and the cap.
  await reconcileContactedForBusiness(settings, r, result);
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
  // Last gate before anything is claimed. Drafting above is unaffected: a
  // tenant can queue drafts while they get round to connecting a mailbox, and
  // they will go out on the first pass after it is connected.
  const noMailbox = await outreachMailboxMissing(settings, r);
  if (noMailbox) {
    result.notes.push({ businessId: settings.business_id, note: noMailbox });
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

  // Paged, not capped: a fleet larger than one page must not leave the tail of
  // the tenant list permanently unswept. The page bound is a safety rail
  // against a pathological read, not a product limit.
  for (let page = 0; page < MAX_ACTIVE_PAGES; page += 1) {
    const active = await listActiveOutreachSettings(r.db, page * OUTREACH_ACTIVE_PAGE_SIZE);
    for (const settings of active) {
      result.businesses += 1;
      try {
        await sweepBusiness(settings, r, result);
      } catch (err) {
        await recordBusinessFailure(settings, err, r, result);
      }
    }
    if (active.length < OUTREACH_ACTIVE_PAGE_SIZE) break;
  }
  return result;
}

/** Collect one business's failure and carry on with the next. */
async function recordBusinessFailure(
  settings: OutreachSettingsRow,
  err: unknown,
  r: Resolved,
  result: OutreachSweepResult
): Promise<void> {
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
