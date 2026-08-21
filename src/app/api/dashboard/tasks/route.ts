/**
 * Staff Task Center aggregation.
 *
 * GET /api/dashboard/tasks?businessId=<uuid>&scope=mine|all|unowned
 *   → { tasks: TaskCardData[], employees: {id,name}[], myEmployeeId,
 *       implicitOwnerEmployeeId }
 *
 * A task = a lead in motion: a contact with non-terminal AiFlow runs and/or
 * lead-state tags. Each card combines the five Task Center facets:
 *   - active workflow (flow name + current node via the flattened cursor),
 *   - lead state (contact tags + owning roster member),
 *   - goal events (recorded goal checkpoints + the routing claim),
 *   - collected info (run vars + the contact's rolling summary),
 *   - response reasoning (latest ai_reply_reasoning rows).
 *
 * Auth: requireBusinessRole(businessId, "view_dashboard"), staff can see
 * it. scope=mine filters to contacts OWNED by the caller's linked roster
 * member (business_members.employee_id → contacts.owner_employee_id);
 * callers with no linked roster member get an empty "mine" list rather
 * than everyone's (the toggle tells them why). scope=unowned filters to
 * cards whose RESOLVED owner is null (explicit stamp or the implicit
 * one-person-roster owner), the claimable set the board's Claim button
 * acts on.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  ACTIVE_RUN_STATUSES,
  goalTimeline,
  runPosition,
  taskLeadPhone,
  type GoalTimelineEntry
} from "@/lib/ai-flows/tasks";
import { runTriggerEntries, runVarEntries, type RunDataEntry } from "@/lib/ai-flows/run-stats";
import type { FlowStep } from "@/lib/ai-flows/schema";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { effectiveContactOwner } from "@/lib/contacts/owner-attribution";
import { resolveCallerEmployeeId } from "@/lib/db/caller-employee";
import { resolveImplicitContactOwner } from "@/lib/db/implicit-contact-owner";
import { getActivityForContacts, type ActivityItem } from "@/lib/db/activity";
import { listContactsByLeadPhone, listTaggedContacts } from "@/lib/contacts/lookup";
import { listAiFlowDefinitions } from "@/lib/ai-flows/db";
import { isVpsReadMode } from "@/lib/residency/read";

export const dynamic = "force-dynamic";

/**
 * Contact projection behind both contacts reads below, shared by the box and
 * central paths (`src/lib/contacts/lookup.ts` joins it for PostgREST) so the
 * two can never drift apart.
 */
const CONTACT_COLUMNS = [
  "customer_e164",
  "alias_e164s",
  "display_name",
  "summary_md",
  "tags",
  "owner_employee_id",
  "updated_at"
] as const;

const READ_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({
  businessId: z.string().uuid(),
  scope: z.enum(["mine", "all", "unowned"]).default("all")
});

/** Most leads one response carries; newest activity first. */
const MAX_TASKS = 60;
const MAX_RUNS = 200;
const REASONING_PER_TASK = 3;
const ACTIVITY_PER_TASK = 3;

type RunRow = {
  id: string;
  flow_id: string;
  status: string;
  current_step: number;
  context: Record<string, unknown> | null;
  respond_by_at: string | null;
  earliest_claim_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskRunView = {
  id: string;
  flowId: string;
  flowName: string;
  status: string;
  stepNumber: number;
  totalSteps: number;
  nodeLabel: string;
  stepType: string;
  /** awaiting_reply deadline / deferred wake time, when parked. */
  waitingUntil: string | null;
  updatedAt: string;
};

export type TaskReasoningView = {
  intent: string;
  rationale: string;
  escalated: boolean;
  replyPreview: string | null;
  at: string;
};

export type TaskCardData = {
  e164: string;
  name: string;
  /**
   * The RAW stored label (contacts.display_name). `name` above is the
   * RESOLVED one (manual label, owner/employee overlay, else the phone), so
   * the quick editor edits THIS and must never echo `name` back into it.
   */
  displayName: string | null;
  /**
   * False for cards synthesized from runs whose lead has no contact row
   * yet; there is nothing to edit or delete until the flow files them.
   */
  hasContact: boolean;
  tags: string[];
  ownerEmployeeId: string | null;
  ownerName: string | null;
  summary: string | null;
  runs: TaskRunView[];
  goals: (GoalTimelineEntry & { flowName: string })[];
  claimedBy: string | null;
  vars: RunDataEntry[];
  reasoning: TaskReasoningView[];
  /** The lead's newest cross-channel events (calls + texts), newest first. */
  activity: ActivityItem[];
  lastActivityAt: string;
};

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId, scope } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? "",
      scope: url.searchParams.get("scope") ?? "all"
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "view_dashboard");

    const limiter = rateLimit(`tasks:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const db = await createSupabaseServiceClient();

    // `contacts` and `ai_flows` are both residency-moved, so for a tenant in
    // vps mode the rows behind this board are served from that tenant's own
    // box. Both are tables the purge KEEPS central, so this is on-box
    // serving, not a fix for missing rows. One mode lookup up front, reused
    // by every routed read below.
    const vpsReadMode = await isVpsReadMode(businessId, db);

    // The roster member the caller IS (drives scope=mine): their explicit
    // business_members link, or the owner's own roster row, owner logins
    // have no member row, so "mine" used to come back empty for them.
    const myEmployeeId = await resolveCallerEmployeeId(businessId, user.email, db);

    // 1) Leads in motion: non-terminal runs, newest activity first.
    const { data: runData, error: runErr } = await db
      .from("ai_flow_runs")
      .select(
        "id, flow_id, status, current_step, context, respond_by_at, earliest_claim_at, created_at, updated_at"
      )
      .eq("business_id", businessId)
      .in("status", [...ACTIVE_RUN_STATUSES])
      .order("updated_at", { ascending: false })
      .limit(MAX_RUNS);
    if (runErr) throw new Error(`tasks: runs: ${runErr.message}`);
    const runs = (runData ?? []) as RunRow[];

    // 2) Their flow definitions (names + step trees for the cursor mapping).
    const flowIds = [...new Set(runs.map((r) => r.flow_id))];
    const flowsById = new Map<string, { name: string; steps: FlowStep[] }>();
    for (const row of await listAiFlowDefinitions(businessId, flowIds, {
      client: db,
      vpsReadMode
    })) {
      const steps = Array.isArray(row.definition?.steps)
        ? (row.definition.steps as FlowStep[])
        : [];
      flowsById.set(row.id, { name: row.name, steps });
    }

    // Group runs by lead phone. Runs with no identifiable lead are dropped,
    // a task card is a PERSON, and schedule/webhook runs without an extracted
    // lead have nobody to pin the card on.
    const runsByLead = new Map<string, RunRow[]>();
    for (const run of runs) {
      const phone = taskLeadPhone(run.context ?? {});
      if (!phone) continue;
      const list = runsByLead.get(phone) ?? [];
      list.push(run);
      runsByLead.set(phone, list);
    }

    // 3) Contacts: everyone with an active run, plus (scope-dependent) every
    //    tagged contact, a lead can be mid-lifecycle with no queued run.
    //    Alias-aware: a run's lead phone may be a merged-away number whose
    //    surviving contact row is keyed on a different primary, those runs
    //    are re-keyed onto the primary so one lead is always ONE card.
    const phones = [...runsByLead.keys()];
    type ContactRow = {
      customer_e164: string;
      alias_e164s: string[] | null;
      display_name: string | null;
      summary_md: string | null;
      tags: string[] | null;
      owner_employee_id: string | null;
      updated_at: string;
    };
    const contactsByPhone = new Map<string, ContactRow>();
    const lookup = { businessId, db, vpsReadMode, label: "tasks" };
    {
      // On a vps tenant the box matches PRIMARY numbers only (no OR, no
      // array overlap in its filter grammar), so a run keyed on a
      // merged-away alias finds no contact and stays on its own card as an
      // unresolved lead instead of being folded onto, and labeled with, some
      // other person's profile. Same trade PR #1547 made for this filter.
      const aliasToPrimary = new Map<string, string>();
      for (const c of await listContactsByLeadPhone<ContactRow>(lookup, {
        columns: CONTACT_COLUMNS,
        phones
      })) {
        contactsByPhone.set(c.customer_e164, c);
        for (const alias of c.alias_e164s ?? []) {
          aliasToPrimary.set(alias, c.customer_e164);
        }
      }
      // Re-key runs grouped under an alias onto the surviving primary,
      // newest-first so the "collected info" facet reads the latest run.
      for (const [phone, leadRuns] of [...runsByLead]) {
        const primary = aliasToPrimary.get(phone);
        if (!primary || primary === phone) continue;
        const merged = [...(runsByLead.get(primary) ?? []), ...leadRuns].sort((a, b) =>
          a.updated_at < b.updated_at ? 1 : -1
        );
        runsByLead.set(primary, merged);
        runsByLead.delete(phone);
      }
    }
    // Tagged contacts without an active run round out the board. Cap keeps
    // the page bounded for tag-heavy tenants.
    for (const c of await listTaggedContacts<ContactRow>(lookup, {
      columns: CONTACT_COLUMNS,
      limit: MAX_TASKS
    })) {
      if (!contactsByPhone.has(c.customer_e164)) contactsByPhone.set(c.customer_e164, c);
    }
    // A lead can be in motion with NO contact row yet (the flow hasn't filed
    // them, or the profile is keyed on a merged-away number). Their runs must
    // still get a card, synthesize a bare contact so the workflow position
    // shows even before the CRM entry exists. Tracked so the card can say it
    // has no contact record behind it (the quick editor needs a row to PATCH).
    const synthesizedPhones = new Set<string>();
    for (const [phone, leadRuns] of runsByLead) {
      if (contactsByPhone.has(phone)) continue;
      synthesizedPhones.add(phone);
      contactsByPhone.set(phone, {
        customer_e164: phone,
        alias_e164s: null,
        display_name: null,
        summary_md: null,
        tags: [],
        owner_employee_id: null,
        updated_at: leadRuns[0]?.updated_at ?? new Date().toISOString()
      });
    }

    // 4) Roster names for owner badges.
    const { data: memberData } = await db
      .from("ai_flow_team_members")
      .select("id, name")
      .eq("business_id", businessId);
    const employees = ((memberData ?? []) as Array<{ id: string; name: string }>).map((m) => ({
      id: m.id,
      name: m.name
    }));
    const employeeNameById = new Map(employees.map((m) => [m.id, m.name]));
    // One-person team whose only member is the owner: their unclaimed leads
    // are theirs, so the cards name them and scope=mine returns those leads
    // instead of an empty board. The roster select above carries only
    // id + name, so this reads the roster's own columns.
    const implicitOwner = await resolveImplicitContactOwner(businessId, db);

    // 5) Goal checkpoints recorded on the shown runs.
    const goalsByRun = new Map<string, GoalTimelineEntry[]>();
    if (runs.length > 0) {
      const { data: goalData, error: goalErr } = await db
        .from("ai_flow_run_steps")
        .select("run_id, step_type, status, result, updated_at")
        .eq("business_id", businessId)
        .eq("step_type", "goal")
        .in("run_id", runs.map((r) => r.id));
      if (goalErr) throw new Error(`tasks: goal steps: ${goalErr.message}`);
      for (const entry of goalTimeline(
        (goalData ?? []) as Array<{
          run_id: string;
          step_type: string;
          status: string;
          result: Record<string, unknown> | null;
          updated_at: string;
        }>
      )) {
        const list = goalsByRun.get(entry.runId) ?? [];
        list.push(entry);
        goalsByRun.set(entry.runId, list);
      }
    }

    // 6) Latest response reasoning per lead. Fetched PER CONTACT (small,
    // index-served lookups in parallel) rather than one globally-capped
    // query: a single chatty lead would otherwise exhaust the cap and starve
    // every other card's reasoning section. Alias-aware: replies to a
    // merged-away number stored their reasoning under that alias, so each
    // card reads its primary AND its aliases (keyed back to the primary).
    const reasoningByPhone = new Map<string, TaskReasoningView[]>();
    const allPhones = [...contactsByPhone.keys()];
    if (allPhones.length > 0) {
      await Promise.all(
        allPhones.map(async (phone) => {
          const numbers = [phone, ...(contactsByPhone.get(phone)?.alias_e164s ?? [])];
          const { data, error } = await db
            .from("ai_reply_reasoning")
            .select("intent, rationale, escalated, reply_preview, created_at")
            .eq("business_id", businessId)
            .in("contact_e164", numbers)
            .order("created_at", { ascending: false })
            .limit(REASONING_PER_TASK);
          if (error) throw new Error(`tasks: reasoning: ${error.message}`);
          const rows = (data ?? []) as Array<{
            intent: string;
            rationale: string;
            escalated: boolean;
            reply_preview: string | null;
            created_at: string;
          }>;
          if (rows.length > 0) {
            reasoningByPhone.set(
              phone,
              rows.map((row) => ({
                intent: row.intent,
                rationale: row.rationale,
                escalated: row.escalated,
                replyPreview: row.reply_preview,
                at: row.created_at
              }))
            );
          }
        })
      );
    }

    // Display names (owner/employee overlays + manual labels win).
    const contactNames = await resolveContactNames(businessId, allPhones, db).catch(
      () => new Map<string, ContactName>()
    );

    // Recent cross-channel activity per lead, batched over every card's
    // numbers (primary + merge aliases) in one IN() query per source.
    // Best-effort: a feed error never blocks the board.
    const activityNumbers = [
      ...new Set(
        [...contactsByPhone.values()].flatMap((c) => [
          c.customer_e164,
          ...(c.alias_e164s ?? [])
        ])
      )
    ];
    const activityByPhone = await getActivityForContacts(
      businessId,
      activityNumbers,
      { perContact: ACTIVITY_PER_TASK, contactNames },
      db
    ).catch(() => new Map<string, ActivityItem[]>());

    // ── Compose the cards ──────────────────────────────────────────────────
    const cards: TaskCardData[] = [];
    for (const [phone, contact] of contactsByPhone) {
      const leadRuns = runsByLead.get(phone) ?? [];
      const runViews: TaskRunView[] = leadRuns.map((run) => {
        const flow = flowsById.get(run.flow_id);
        const pos = runPosition(flow?.steps ?? [], run.current_step);
        const waitingUntil =
          run.status === "awaiting_reply" ||
          run.status === "awaiting_agent" ||
          run.status === "awaiting_call"
            ? run.respond_by_at
            : run.status === "queued"
              ? run.earliest_claim_at
              : null;
        return {
          id: run.id,
          flowId: run.flow_id,
          flowName: flow?.name ?? "AiFlow",
          status: run.status,
          ...pos,
          waitingUntil,
          updatedAt: run.updated_at
        };
      });

      const goals = leadRuns.flatMap((run) =>
        (goalsByRun.get(run.id) ?? []).map((g) => ({
          ...g,
          flowName: flowsById.get(run.flow_id)?.name ?? "AiFlow"
        }))
      );

      // Who claimed the lead (routing state on the newest run that has one).
      let claimedBy: string | null = null;
      for (const run of leadRuns) {
        const routing = (run.context?.routing ?? {}) as Record<string, unknown>;
        const name =
          (typeof routing.claimed_name === "string" && routing.claimed_name) ||
          (typeof routing.claimed_by === "string" && routing.claimed_by) ||
          "";
        if (name) {
          claimedBy = name;
          break;
        }
      }

      // Collected info from the newest run: extracted vars first, then the
      // trigger data it started from.
      const newest = leadRuns[0];
      const vars: RunDataEntry[] = newest
        ? [
            ...runVarEntries(newest.context ?? {}),
            ...runTriggerEntries(newest.context ?? {}).map((e) => ({
              key: `trigger.${e.key}`,
              value: e.value
            }))
          ]
        : [];

      const lastActivityAt =
        [contact.updated_at, ...leadRuns.map((r) => r.updated_at)].sort().at(-1) ??
        contact.updated_at;

      // Fold alias-keyed activity into the primary's card (merged profiles).
      const activity = [phone, ...(contact.alias_e164s ?? [])]
        .flatMap((n) => activityByPhone.get(n) ?? [])
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, ACTIVITY_PER_TASK);

      const owner = effectiveContactOwner(
        contact.owner_employee_id,
        implicitOwner,
        employeeNameById
      );
      cards.push({
        e164: phone,
        name:
          contactNames.get(phone)?.name ?? contact.display_name ?? phone,
        displayName: contact.display_name,
        hasContact: !synthesizedPhones.has(phone),
        tags: contact.tags ?? [],
        // Explicit stamp first, implicit owner when nobody claimed it. Both
        // the card label and the scope=mine filter below read these.
        ownerEmployeeId: owner?.id ?? null,
        ownerName: owner?.name ?? null,
        summary: contact.summary_md,
        runs: runViews,
        goals,
        claimedBy,
        vars: vars.slice(0, 20),
        reasoning: reasoningByPhone.get(phone) ?? [],
        activity,
        lastActivityAt
      });
    }

    // Scope + ordering + cap. "Mine" with no linked roster member is empty
    // by design, the client explains the linkage instead of showing all.
    // In-motion leads (active runs) always rank above tag-only cards so the
    // MAX_TASKS cap can never hide a running workflow behind recently-edited
    // tagged contacts; within each group, newest activity first.
    // "Unowned" reads the RESOLVED owner, so on a one-person team (where the
    // implicit owner rule makes every unclaimed lead theirs) it is empty:
    // there is nothing to claim on a board that already belongs to somebody.
    const scoped =
      scope === "mine"
        ? cards.filter((c) => myEmployeeId !== null && c.ownerEmployeeId === myEmployeeId)
        : scope === "unowned"
          ? cards.filter((c) => c.ownerEmployeeId === null)
          : cards;
    scoped.sort((a, b) => {
      const aActive = a.runs.length > 0 ? 1 : 0;
      const bActive = b.runs.length > 0 ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
    });

    return successResponse({
      tasks: scoped.slice(0, MAX_TASKS),
      employees,
      myEmployeeId,
      // One-person team whose only member is the owner: the stored owner
      // column would resolve straight back to them, so the quick editor
      // drops its "Unassigned" choice (a control that would do nothing).
      implicitOwnerEmployeeId: implicitOwner?.id ?? null
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
