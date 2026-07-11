/**
 * Staff Task Center aggregation.
 *
 * GET /api/dashboard/tasks?businessId=<uuid>&scope=mine|all
 *   → { tasks: TaskCardData[], employees: {id,name}[], myEmployeeId }
 *
 * A task = a lead in motion: a contact with non-terminal AiFlow runs and/or
 * lead-state tags. Each card combines the five Task Center facets:
 *   - active workflow (flow name + current node via the flattened cursor),
 *   - lead state (contact tags + owning roster member),
 *   - goal events (recorded goal checkpoints + the routing claim),
 *   - collected info (run vars + the contact's rolling summary),
 *   - response reasoning (latest ai_reply_reasoning rows).
 *
 * Auth: requireBusinessRole(businessId, "view_dashboard") — staff can see
 * it. scope=mine filters to contacts OWNED by the caller's linked roster
 * member (business_members.employee_id → contacts.owner_employee_id);
 * callers with no linked roster member get an empty "mine" list rather
 * than everyone's (the toggle tells them why).
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

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({
  businessId: z.string().uuid(),
  scope: z.enum(["mine", "all"]).default("all")
});

/** Most leads one response carries; newest activity first. */
const MAX_TASKS = 60;
const MAX_RUNS = 200;
const MAX_REASONING_ROWS = 180;
const REASONING_PER_TASK = 3;

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
  tags: string[];
  ownerEmployeeId: string | null;
  ownerName: string | null;
  summary: string | null;
  runs: TaskRunView[];
  goals: (GoalTimelineEntry & { flowName: string })[];
  claimedBy: string | null;
  vars: RunDataEntry[];
  reasoning: TaskReasoningView[];
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

    // The caller's linked roster member (drives scope=mine).
    let myEmployeeId: string | null = null;
    if (user.email) {
      const { data: memberRow } = await db
        .from("business_members")
        .select("employee_id")
        .eq("business_id", businessId)
        .eq("email", user.email.trim().toLowerCase())
        .neq("status", "revoked")
        .maybeSingle();
      myEmployeeId = (memberRow as { employee_id?: string | null } | null)?.employee_id ?? null;
    }

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
    if (flowIds.length > 0) {
      const { data: flowData, error: flowErr } = await db
        .from("ai_flows")
        .select("id, name, definition")
        .in("id", flowIds);
      if (flowErr) throw new Error(`tasks: flows: ${flowErr.message}`);
      for (const row of (flowData ?? []) as Array<{
        id: string;
        name: string;
        definition?: { steps?: unknown } | null;
      }>) {
        const steps = Array.isArray(row.definition?.steps)
          ? (row.definition!.steps as FlowStep[])
          : [];
        flowsById.set(row.id, { name: row.name, steps });
      }
    }

    // Group runs by lead phone. Runs with no identifiable lead are dropped —
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
    //    tagged contact — a lead can be mid-lifecycle with no queued run.
    const phones = [...runsByLead.keys()];
    type ContactRow = {
      customer_e164: string;
      display_name: string | null;
      summary_md: string | null;
      tags: string[] | null;
      owner_employee_id: string | null;
      updated_at: string;
    };
    const contactsByPhone = new Map<string, ContactRow>();
    const CONTACT_COLUMNS =
      "customer_e164, display_name, summary_md, tags, owner_employee_id, updated_at";
    if (phones.length > 0) {
      const { data, error } = await db
        .from("contacts")
        .select(CONTACT_COLUMNS)
        .eq("business_id", businessId)
        .in("customer_e164", phones);
      if (error) throw new Error(`tasks: contacts: ${error.message}`);
      for (const c of (data ?? []) as ContactRow[]) {
        contactsByPhone.set(c.customer_e164, c);
      }
    }
    {
      // Tagged contacts without an active run round out the board. Cap keeps
      // the page bounded for tag-heavy tenants.
      const { data, error } = await db
        .from("contacts")
        .select(CONTACT_COLUMNS)
        .eq("business_id", businessId)
        .neq("tags", "{}")
        .order("updated_at", { ascending: false })
        .limit(MAX_TASKS);
      if (error) throw new Error(`tasks: tagged contacts: ${error.message}`);
      for (const c of (data ?? []) as ContactRow[]) {
        if (!contactsByPhone.has(c.customer_e164)) contactsByPhone.set(c.customer_e164, c);
      }
    }
    // A lead can be in motion with NO contact row yet (the flow hasn't filed
    // them, or the profile is keyed on a merged-away number). Their runs must
    // still get a card — synthesize a bare contact so the workflow position
    // shows even before the CRM entry exists.
    for (const [phone, leadRuns] of runsByLead) {
      if (contactsByPhone.has(phone)) continue;
      contactsByPhone.set(phone, {
        customer_e164: phone,
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

    // 6) Latest response reasoning per lead.
    const reasoningByPhone = new Map<string, TaskReasoningView[]>();
    const allPhones = [...contactsByPhone.keys()];
    if (allPhones.length > 0) {
      const { data: reasonData, error: reasonErr } = await db
        .from("ai_reply_reasoning")
        .select("contact_e164, intent, rationale, escalated, reply_preview, created_at")
        .eq("business_id", businessId)
        .in("contact_e164", allPhones)
        .order("created_at", { ascending: false })
        .limit(MAX_REASONING_ROWS);
      if (reasonErr) throw new Error(`tasks: reasoning: ${reasonErr.message}`);
      for (const row of (reasonData ?? []) as Array<{
        contact_e164: string;
        intent: string;
        rationale: string;
        escalated: boolean;
        reply_preview: string | null;
        created_at: string;
      }>) {
        const list = reasoningByPhone.get(row.contact_e164) ?? [];
        if (list.length >= REASONING_PER_TASK) continue;
        list.push({
          intent: row.intent,
          rationale: row.rationale,
          escalated: row.escalated,
          replyPreview: row.reply_preview,
          at: row.created_at
        });
        reasoningByPhone.set(row.contact_e164, list);
      }
    }

    // Display names (owner/employee overlays + manual labels win).
    const contactNames = await resolveContactNames(businessId, allPhones, db).catch(
      () => new Map<string, ContactName>()
    );

    // ── Compose the cards ──────────────────────────────────────────────────
    const cards: TaskCardData[] = [];
    for (const [phone, contact] of contactsByPhone) {
      const leadRuns = runsByLead.get(phone) ?? [];
      const runViews: TaskRunView[] = leadRuns.map((run) => {
        const flow = flowsById.get(run.flow_id);
        const pos = runPosition(flow?.steps ?? [], run.current_step);
        const waitingUntil =
          run.status === "awaiting_reply" || run.status === "awaiting_agent"
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

      cards.push({
        e164: phone,
        name:
          contactNames.get(phone)?.name ?? contact.display_name ?? phone,
        tags: contact.tags ?? [],
        ownerEmployeeId: contact.owner_employee_id,
        ownerName:
          (contact.owner_employee_id &&
            employeeNameById.get(contact.owner_employee_id)) ||
          null,
        summary: contact.summary_md,
        runs: runViews,
        goals,
        claimedBy,
        vars: vars.slice(0, 20),
        reasoning: reasoningByPhone.get(phone) ?? [],
        lastActivityAt
      });
    }

    // Scope + ordering + cap. "Mine" with no linked roster member is empty
    // by design — the client explains the linkage instead of showing all.
    const scoped =
      scope === "mine"
        ? cards.filter((c) => myEmployeeId !== null && c.ownerEmployeeId === myEmployeeId)
        : cards;
    scoped.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));

    return successResponse({
      tasks: scoped.slice(0, MAX_TASKS),
      employees,
      myEmployeeId
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
