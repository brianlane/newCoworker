"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Plus, Trash2, ArrowUp, ArrowDown, Sparkles, Pencil, Copy } from "lucide-react";
import {
  BROWSE_ACTION_KINDS,
  ENGINE_PROVIDED_VARS,
  FLOW_STEP_TYPES,
  GOAL_EVENT_KINDS,
  MATH_OPERATIONS,
  MAX_BRANCH_ARMS,
  MAX_GOAL_EVENTS,
  VOICE_STEP_TYPES,
  TRIGGER_CONDITION_TYPES,
  HTTP_METHODS,
  type AiFlowDefinition,
  type BranchStep,
  type FlowStep,
  type FlowTimeWindow,
  type FlowTrigger,
  type StepCondition,
  type TriggerCondition
} from "@/lib/ai-flows/schema";
import { AiFlowCanvas } from "@/components/dashboard/AiFlowCanvas";
import {
  findStepById,
  flattenForDisplay,
  hasBranchStep,
  insertStepAt,
  moveStepById,
  patchStepById,
  removeStepById,
  varsInScopeBefore,
  varsProducedByStep,
  type StepContainerRef
} from "@/lib/ai-flows/tree";
import type { AiFlowRow } from "@/lib/ai-flows/db";
import {
  STEP_TYPE_LABELS,
  STEP_TYPE_HELP,
  CONDITION_LABELS,
  BROWSE_ACTION_LABELS,
  friendlyFlowSummary
} from "@/components/dashboard/aiflow-labels";
import { getAiFlowExampleCopy, type AiFlowExampleCopy } from "@/lib/ai-flows/examples";
import {
  ContactRefPicker,
  type PickerPerson,
  type PickerRef
} from "@/components/dashboard/ContactRefPicker";
import { SortControl, type SortOption } from "@/components/dashboard/SortControl";
import { sortRows } from "@/lib/dashboard/sort";
import { usePersistentSort } from "@/components/dashboard/usePersistentSort";
import { useUnsavedChangesWarning } from "@/components/dashboard/useBusinessConfigSave";

// Sort fields for the flows list. Default is "last run" desc, matching the
// server's activity ordering so the list opens unchanged.
const AIFLOW_SORT_OPTIONS: SortOption[] = [
  { key: "last_run_at", label: "Last run" },
  { key: "name", label: "Name" },
  { key: "created_at", label: "Created" },
  { key: "updated_at", label: "Updated" }
];

function aiFlowSortValue(row: AiFlowRow, field: string): string | number | null | undefined {
  if (field === "name") return row.name;
  if (field === "created_at") return row.created_at;
  if (field === "updated_at") return row.updated_at;
  return row.last_run_at;
}

// Mirrors EMAIL_PROVIDER_CONFIG_KEYS in src/lib/voice-tools/connections.ts —
// that module is server-only (it pulls in the service-role Supabase client),
// so the client bundle keeps its own copy of these three string keys.
const EMAIL_CONNECTION_KEYS = ["google-mail", "gmail", "outlook"];

/** A connected owner mailbox the editor can offer as an email "From". */
export type EmailConnectionOption = { id: string; label: string };

/** A team member with an email, offered in the cc/bcc "Add employee" picker. */
export type EmployeeEmailOption = { name: string; email: string };

/** A shareable business document, offered in the share_document step picker. */
export type DocumentOption = { id: string; title: string; expired: boolean };

/** A saved agent, offered in the run_agent step picker. */
export type AgentOption = { id: string; name: string; enabled: boolean };

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

/** How the workflow starts. Mirrors TRIGGER_CHANNELS in the schema. */
const CHANNEL_LABELS: Record<FlowTrigger["channel"], string> = {
  sms: "Inbound text (SMS)",
  manual: "Manual: Run now button",
  schedule: "On a schedule",
  email: "Inbound email (your connected inbox)",
  tenant_email: "Inbound email (AI coworker's mailbox)",
  webhook: "Webhook (Zapier, Make, or API)",
  calendar: "Calendar event",
  contact_created: "Contact created",
  tag_changed: "Tag added / removed on a contact",
  owner_assigned: "Contact assigned an owner",
  birthday: "Contact's birthday",
  voice: "Voice call routing"
};

/** Step types available for a voice flow vs. every other (batch) channel. */
const VOICE_STEP_TYPE_SET = new Set<string>(VOICE_STEP_TYPES);
// The classic form editor offers every batch step EXCEPT branch: nested arm
// steps need the visual canvas builder to author (an existing branch flow
// still loads/saves here untouched).
const NON_VOICE_STEP_TYPES = FLOW_STEP_TYPES.filter(
  (t) => !VOICE_STEP_TYPE_SET.has(t) && t !== "branch"
);
// The visual canvas builder owns branch authoring, so its picker offers every
// batch step INCLUDING branch.
const VISUAL_BATCH_STEP_TYPES = FLOW_STEP_TYPES.filter((t) => !VOICE_STEP_TYPE_SET.has(t));
/** localStorage key for the Visual | Classic editor preference. */
const EDITOR_MODE_STORAGE_KEY = "aiflow-editor-mode";
/** Inbound voice flows route a live caller; outbound flows place one call. */
const INBOUND_VOICE_STEP_TYPES = VOICE_STEP_TYPES.filter((t) => t !== "outbound_call");
const OUTBOUND_VOICE_STEP_TYPES = ["outbound_call"] as const;

type EditorState = {
  id: string | null;
  name: string;
  enabled: boolean;
  suppressDefaultReply: boolean;
  captureStepScreenshots: boolean;
  channel: FlowTrigger["channel"];
  correlationWindowMinutes: number;
  conditions: TriggerCondition[];
  scheduleMode: "daily" | "every";
  scheduleTime: string;
  scheduleTimezone: string;
  scheduleDays: number[];
  scheduleEvery: number;
  emailConnectionId: string;
  /** Calendar trigger: which calendar(s) to watch. */
  calendarSource: "primary" | "shared" | "both";
  /** Calendar trigger: fire on new events, ahead of a start, after an end, or on cancel. */
  calendarOn: "event_created" | "event_start" | "event_end" | "event_canceled";
  /** Calendar trigger (event_start): minutes before the start to run. */
  calendarLeadMinutes: number;
  /** Calendar trigger (event_end): minutes after the ACTUAL end to run (0 = right away). */
  calendarFollowMinutes: number;
  /** Voice trigger: the E.164 caller id that fires inbound routing. */
  voiceFromE164: string;
  /** Voice trigger: a saved person whose live number matches the caller instead. */
  voiceFromRef: PickerRef | null;
  /** Voice trigger direction: "inbound" matches a caller; "outbound" places a call. */
  voiceDirection: "inbound" | "outbound";
  /** Outbound voice only: auto-dial on the schedule fields above (else manual). */
  voiceOutboundScheduled: boolean;
  /** tag_changed trigger: the tag to watch ("" = any tag). */
  tagChangedTag: string;
  /** tag_changed trigger: fire when the tag is added or removed. */
  tagChangedChange: "added" | "removed";
  /** birthday trigger: local send time (24h HH:MM). */
  birthdayTime: string;
  /** birthday trigger: IANA zone ("" = the business timezone). */
  birthdayTimezone: string;
  /** Flow-level drip pacing: minutes between bulk-enqueued runs (null = off). */
  dripIntervalMinutes: number | null;
  /**
   * Multi-trigger (OR) support: the OTHER triggers in the flow's set, as
   * stored FlowTrigger objects — the per-channel fields above always hold the
   * ONE trigger currently being edited. `editingTriggerIndex` is that
   * trigger's position within the full ordered set (composed at save/switch
   * time by inserting the edited trigger back among these).
   */
  extraTriggers: FlowTrigger[];
  editingTriggerIndex: number;
  /** Flow-level business-hours gate on communication steps (null = always). */
  timeWindow: FlowTimeWindow | null;
  steps: FlowStep[];
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Phoenix";
  } catch {
    return "America/Phoenix";
  }
}

function emptyEditor(): EditorState {
  return {
    id: null,
    name: "",
    enabled: true,
    suppressDefaultReply: false,
    captureStepScreenshots: false,
    channel: "sms",
    correlationWindowMinutes: 10,
    conditions: [{ type: "has_url" }],
    scheduleMode: "daily",
    scheduleTime: "08:30",
    scheduleTimezone: browserTimezone(),
    scheduleDays: [],
    scheduleEvery: 60,
    emailConnectionId: "",
    calendarSource: "both",
    calendarOn: "event_created",
    calendarLeadMinutes: 30,
    calendarFollowMinutes: 0,
    voiceFromE164: "",
    voiceFromRef: null,
    voiceDirection: "inbound",
    voiceOutboundScheduled: false,
    tagChangedTag: "",
    tagChangedChange: "added",
    birthdayTime: "09:00",
    birthdayTimezone: "",
    dripIntervalMinutes: null,
    extraTriggers: [],
    editingTriggerIndex: 0,
    timeWindow: null,
    steps: []
  };
}

/** The flow's full ordered trigger set with the edited trigger re-inserted. */
function composeTriggerSet(s: EditorState): FlowTrigger[] {
  const full = [...s.extraTriggers];
  const at = Math.min(Math.max(0, s.editingTriggerIndex), full.length);
  full.splice(at, 0, editorTrigger(s));
  return full;
}

/** Switch which trigger of the set the per-channel fields edit. */
function selectTriggerForEdit(s: EditorState, index: number): EditorState {
  const full = composeTriggerSet(s);
  const clamped = Math.min(Math.max(0, index), full.length - 1);
  const chosen = full[clamped];
  const rest = full.filter((_, i) => i !== clamped);
  return {
    ...s,
    ...triggerToEditorFields(chosen),
    extraTriggers: rest,
    editingTriggerIndex: clamped
  };
}

/** Trigger-derived editor fields (shared by editorFromRow + the AI generator). */
function triggerToEditorFields(trigger: FlowTrigger): Pick<
  EditorState,
  | "channel"
  | "correlationWindowMinutes"
  | "conditions"
  | "scheduleMode"
  | "scheduleTime"
  | "scheduleTimezone"
  | "scheduleDays"
  | "scheduleEvery"
  | "emailConnectionId"
  | "calendarSource"
  | "calendarOn"
  | "calendarLeadMinutes"
  | "calendarFollowMinutes"
  | "voiceFromE164"
  | "voiceFromRef"
  | "voiceDirection"
  | "voiceOutboundScheduled"
  | "tagChangedTag"
  | "tagChangedChange"
  | "birthdayTime"
  | "birthdayTimezone"
> {
  const base = {
    channel: trigger.channel,
    correlationWindowMinutes: 10,
    conditions: [] as TriggerCondition[],
    scheduleMode: "daily" as const,
    scheduleTime: "08:30",
    scheduleTimezone: browserTimezone(),
    scheduleDays: [] as number[],
    scheduleEvery: 60,
    emailConnectionId: "",
    calendarSource: "both" as const,
    calendarOn: "event_created" as const,
    calendarLeadMinutes: 30,
    calendarFollowMinutes: 0,
    voiceFromE164: "",
    voiceFromRef: null as PickerRef | null,
    voiceDirection: "inbound" as const,
    voiceOutboundScheduled: false,
    tagChangedTag: "",
    tagChangedChange: "added" as const,
    birthdayTime: "09:00",
    birthdayTimezone: ""
  };
  switch (trigger.channel) {
    case "sms":
      return {
        ...base,
        correlationWindowMinutes: trigger.correlationWindowMinutes ?? 10,
        conditions: trigger.conditions
      };
    case "manual":
      return base;
    case "schedule":
      if (trigger.everyMinutes !== undefined) {
        return { ...base, scheduleMode: "every", scheduleEvery: trigger.everyMinutes };
      }
      return {
        ...base,
        scheduleTime: trigger.time ?? "08:30",
        scheduleTimezone: trigger.timezone ?? browserTimezone(),
        scheduleDays: trigger.daysOfWeek ?? []
      };
    case "email":
      return {
        ...base,
        conditions: trigger.conditions,
        emailConnectionId: trigger.connectionId
      };
    case "tenant_email":
      return { ...base, conditions: trigger.conditions };
    case "webhook":
      return { ...base, conditions: trigger.conditions };
    case "contact_created":
      return { ...base, conditions: trigger.conditions };
    case "tag_changed":
      return {
        ...base,
        conditions: trigger.conditions,
        tagChangedTag: trigger.tag ?? "",
        tagChangedChange: trigger.change ?? "added"
      };
    case "owner_assigned":
      return { ...base, conditions: trigger.conditions };
    case "birthday":
      return {
        ...base,
        conditions: trigger.conditions,
        birthdayTime: trigger.time ?? "09:00",
        birthdayTimezone: trigger.timezone ?? ""
      };
    case "calendar":
      return {
        ...base,
        conditions: trigger.conditions,
        calendarSource: trigger.calendar ?? "both",
        calendarOn: trigger.on,
        calendarLeadMinutes: trigger.leadMinutes ?? 30,
        calendarFollowMinutes: trigger.followMinutes ?? 0
      };
    case "voice": {
      const scheduled =
        trigger.direction === "outbound" &&
        (trigger.everyMinutes !== undefined ||
          (trigger.time !== undefined && trigger.timezone !== undefined));
      const sched = scheduled
        ? trigger.everyMinutes !== undefined
          ? { scheduleMode: "every" as const, scheduleEvery: trigger.everyMinutes }
          : {
              scheduleMode: "daily" as const,
              scheduleTime: trigger.time ?? "08:30",
              scheduleTimezone: trigger.timezone ?? browserTimezone(),
              scheduleDays: trigger.daysOfWeek ?? []
            }
        : {};
      return {
        ...base,
        ...sched,
        voiceFromE164: trigger.fromE164 ?? "",
        voiceFromRef: trigger.fromRef ?? null,
        voiceDirection: trigger.direction === "outbound" ? "outbound" : "inbound",
        voiceOutboundScheduled: scheduled
      };
    }
  }
}

function editorFromRow(row: AiFlowRow): EditorState {
  const def = row.definition;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    suppressDefaultReply: def.options?.suppressDefaultReply ?? false,
    captureStepScreenshots: def.options?.captureStepScreenshots ?? false,
    ...triggerToEditorFields(def.trigger),
    extraTriggers: def.triggers ?? [],
    editingTriggerIndex: 0,
    timeWindow: def.timeWindow ?? null,
    dripIntervalMinutes: def.drip?.intervalMinutes ?? null,
    steps: def.steps
  };
}

/** A NEW (unsaved) editor pre-loaded from a definition — used by AI generate
 *  and the "Adapt with AI" library hand-off. Starts disabled for review. */
function editorFromDefinition(def: AiFlowDefinition, name: string): EditorState {
  return {
    id: null,
    name,
    enabled: false,
    suppressDefaultReply: def.options?.suppressDefaultReply ?? false,
    captureStepScreenshots: def.options?.captureStepScreenshots ?? false,
    ...triggerToEditorFields(def.trigger),
    extraTriggers: def.triggers ?? [],
    editingTriggerIndex: 0,
    timeWindow: def.timeWindow ?? null,
    dripIntervalMinutes: def.drip?.intervalMinutes ?? null,
    steps: def.steps
  };
}

function freshStepId(): string {
  return `s_${(crypto.randomUUID?.() ?? String(Date.now())).slice(0, 8)}`;
}

function newStep(type: FlowStep["type"], examples: AiFlowExampleCopy): FlowStep {
  const id = freshStepId();
  switch (type) {
    case "extract_url":
      return { id, type, saveAs: "lead_url" };
    case "browse_extract":
      return { id, type, urlVar: "lead_url", fields: [{ name: examples.contactVar, description: "" }] };
    case "extract_text":
      return { id, type, fields: [{ name: examples.contactVar, description: "" }] };
    case "email_extract":
      return {
        id,
        type,
        connectionId: "",
        fromContains: "",
        lookbackMinutes: 60,
        fillOnlyEmpty: true,
        fields: [{ name: examples.contactVar, description: "" }]
      };
    case "send_sms":
      return { id, type, to: `{{vars.${examples.contactVar}}}`, body: "" };
    case "send_email":
      return { id, type, to: "", subject: "", body: "" };
    case "approval_gate":
      return { id, type, prompt: "Send this message?" };
    case "notify_owner":
      return { id, type, message: "" };
    case "http_call":
      return { id, type, label: "", method: "POST", path: "", bodyTemplate: "", saveAs: "" };
    case "route_to_team":
      return {
        id,
        type,
        offerTemplate:
          "New lead {{vars.lead_name}} ({{vars.lead_phone}}) in {{vars.location}}. " +
          "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
          'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out ' +
          '(e.g. "1, 20 min").\n' +
          'Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").',
        responseMinutes: 10,
        ownerFallbackTemplate:
          "No agent claimed {{vars.lead_name}} ({{vars.lead_phone}}). It's back to you."
        // claimedNotifyTemplate is optional and omitted by default — an empty
        // string would fail the schema's min(1)-when-present rule on save.
      };
    case "browse_action":
      return {
        id,
        type,
        urlVar: "lead_url",
        actions: [{ kind: "click_text", target: "" }]
      };
    case "recall_url":
      return { id, type, keyFromTrigger: "participants", saveAs: "saved_url" };
    case "upsert_customer":
      return { id, type, phoneVar: "lead_phone", nameVar: "lead_name", emailVar: "lead_email" };
    case "update_contact":
      return { id, type, phoneVar: "lead_phone", addTags: ["Contacted"], removeTags: ["New Lead"] };
    case "classify":
      return {
        id,
        type,
        textVar: "reply_text",
        saveAs: "intent",
        categories: [
          { value: "wants_a_call", description: "asks to talk, call, book, or schedule" },
          { value: "not_interested", description: "declines or asks to stop" }
        ]
      };
    case "generate_image":
      return { id, type, promptTemplate: "", saveAs: "image_url" };
    case "share_document":
      // documentId is filled from the picker; the placeholder uuid never
      // saves (the API validates the document exists for this business).
      return {
        id,
        type,
        documentId: "",
        to: `{{vars.${examples.contactVar}}}`,
        via: "sms",
        messageTemplate: "Here it is: {{share_url}}"
      };
    case "run_agent":
      // agentId is filled from the picker; the empty id never saves (the API
      // validates the agent exists + is enabled for this business).
      return {
        id,
        type,
        agentId: "",
        input: "{{trigger.windowText}}",
        saveAs: "agent_output"
      };
    case "sleep":
      return { id, type, minutes: 300 };
    case "wait_for_reply":
      return { id, type, phoneVar: examples.contactVar, saveAs: "reply_text", timeoutMinutes: 300 };
    case "place_ai_call":
      return {
        id,
        type,
        toVar: examples.contactVar,
        personaTemplate:
          "Hi, I'm calling with the office. How are you today? We're following up — is now a good time to talk?",
        notifyE164: "",
        saveAs: "call_outcome"
      };
    case "goal":
      return { id, type, label: "Appointment booked", events: [{ kind: "appointment_booked" }] };
    case "math":
      return { id, type, operation: "add", left: "{{vars.lead_score}}", right: "10", saveAs: "lead_score" };
    case "branch":
      // Authored via the visual canvas builder; the classic form never offers
      // this type (NON_VOICE_STEP_TYPES filters it) but the switch stays
      // exhaustive over FlowStep["type"].
      return {
        id,
        type,
        question: "Which path?",
        branches: [
          {
            id: freshStepId(),
            label: "Path 1",
            condition: { var: examples.contactVar, notEquals: "none" },
            steps: []
          }
        ],
        else: []
      };
    case "ring_handoff":
      return { id, type, toE164: "", ringSeconds: 20 };
    case "voice_ai_intake":
      return {
        id,
        type,
        notifyE164: "",
        persona: "",
        captureFields: ["name", "phone", "reason for calling"]
      };
    case "voice_transfer":
      return { id, type, toE164: "", whisper: "" };
    case "outbound_call":
      return {
        id,
        type,
        toE164: "",
        notifyE164: "",
        persona: "",
        captureFields: ["name", "phone", "reason for calling"]
      };
  }
}

/**
 * Deep-clone a step with fresh ids, for the per-step duplicate button. A
 * branch clone refreshes every nested step/arm id too — step ids must stay
 * unique across the whole flow tree.
 */
function duplicateOf(step: FlowStep): FlowStep {
  const clone = { ...(JSON.parse(JSON.stringify(step)) as FlowStep), id: freshStepId() };
  if (clone.type === "branch") {
    clone.branches = clone.branches.map((arm) => ({
      ...arm,
      id: freshStepId(),
      steps: arm.steps.map(duplicateOf)
    }));
    clone.else = clone.else.map(duplicateOf);
  }
  return clone;
}

/** All vars produced by steps BEFORE `index` — the legal targets for a `when`. */
function varsProducedBefore(steps: FlowStep[], index: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < index; i++) {
    for (const v of varsProducedByStep(steps[i])) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

/**
 * Save-time condition cleanup: a from_matches with a picked ref must not also
 * carry stale text (exactly-one rule), and an empty text value is dropped so
 * the semantic "needs a sender" message shows instead of a zod min(1) error.
 */
function sanitizeConditions(conditions: TriggerCondition[]): TriggerCondition[] {
  return conditions.map((c) =>
    c.type === "from_matches"
      ? { ...c, value: c.ref ? undefined : c.value?.trim() || undefined }
      : c
  );
}

function editorTrigger(s: EditorState): FlowTrigger {
  switch (s.channel) {
    case "sms":
      return {
        channel: "sms",
        correlationWindowMinutes: s.correlationWindowMinutes,
        conditions: sanitizeConditions(s.conditions)
      };
    case "manual":
      return { channel: "manual" };
    case "schedule":
      return s.scheduleMode === "every"
        ? { channel: "schedule", everyMinutes: s.scheduleEvery }
        : {
            channel: "schedule",
            time: s.scheduleTime,
            timezone: s.scheduleTimezone,
            ...(s.scheduleDays.length > 0 ? { daysOfWeek: [...s.scheduleDays].sort() } : {})
          };
    case "email":
      return {
        channel: "email",
        connectionId: s.emailConnectionId,
        conditions: sanitizeConditions(s.conditions)
      };
    case "tenant_email":
      return { channel: "tenant_email", conditions: sanitizeConditions(s.conditions) };
    case "webhook":
      return { channel: "webhook", conditions: sanitizeConditions(s.conditions) };
    case "contact_created":
      return { channel: "contact_created", conditions: sanitizeConditions(s.conditions) };
    case "tag_changed":
      return {
        channel: "tag_changed",
        ...(s.tagChangedTag.trim() ? { tag: s.tagChangedTag.trim() } : {}),
        ...(s.tagChangedChange === "removed" ? { change: "removed" as const } : {}),
        conditions: sanitizeConditions(s.conditions)
      };
    case "owner_assigned":
      return { channel: "owner_assigned", conditions: sanitizeConditions(s.conditions) };
    case "birthday":
      return {
        channel: "birthday",
        ...(s.birthdayTime && s.birthdayTime !== "09:00" ? { time: s.birthdayTime } : {}),
        ...(s.birthdayTimezone.trim() ? { timezone: s.birthdayTimezone.trim() } : {}),
        conditions: sanitizeConditions(s.conditions)
      };
    case "calendar":
      return {
        channel: "calendar",
        calendar: s.calendarSource,
        on: s.calendarOn,
        ...(s.calendarOn === "event_start" ? { leadMinutes: s.calendarLeadMinutes } : {}),
        // 0 = fire right at the event's end, which is the schema default —
        // only a real delay is stored.
        ...(s.calendarOn === "event_end" && s.calendarFollowMinutes > 0
          ? { followMinutes: s.calendarFollowMinutes }
          : {}),
        conditions: sanitizeConditions(s.conditions)
      };
    case "voice":
      if (s.voiceDirection !== "outbound") {
        // Exactly one caller source: a saved-person ref (live number) or a
        // hardcoded E.164.
        return s.voiceFromRef
          ? { channel: "voice", fromRef: s.voiceFromRef }
          : { channel: "voice", fromE164: s.voiceFromE164.trim() };
      }
      if (!s.voiceOutboundScheduled) {
        return { channel: "voice", direction: "outbound" };
      }
      return s.scheduleMode === "every"
        ? { channel: "voice", direction: "outbound", everyMinutes: s.scheduleEvery }
        : {
            channel: "voice",
            direction: "outbound",
            time: s.scheduleTime,
            timezone: s.scheduleTimezone,
            ...(s.scheduleDays.length > 0 ? { daysOfWeek: [...s.scheduleDays].sort() } : {})
          };
  }
}

/**
 * browse_action looping (forEachLink) is mutually exclusive with same-pass
 * extraction, screenshot, and remember-link (enforced in
 * validateDefinitionSemantics). The builder HIDES those controls while a
 * forEachLink selector is set but keeps their values in editor state, so
 * clearing the selector restores them without data loss. We strip them here, at
 * save time, so the persisted definition is always valid.
 */
function sanitizeStepForSave(step: FlowStep): FlowStep {
  // branch: recurse so nested arm/else steps get the same save-time cleanup
  // as trunk steps (ref-wins rules, blank-field drops, forEachLink stripping).
  if (step.type === "branch") {
    return {
      ...step,
      branches: step.branches.map((arm) => ({
        ...arm,
        steps: arm.steps.map(sanitizeStepForSave)
      })),
      else: step.else.map(sanitizeStepForSave)
    };
  }
  // ring_handoff / voice_transfer: the number source is EITHER a saved-contact
  // ref (live number) or a hardcoded E.164 — a chosen ref supersedes any stale
  // text, and a blank text field is dropped so the semantic "no number to
  // ring" message shows instead of a regex error.
  if (step.type === "ring_handoff" || step.type === "voice_transfer") {
    const toE164 = step.toRef ? undefined : step.toE164?.trim() || undefined;
    return { ...step, toE164 };
  }
  // voice_ai_intake: same ref-wins rule for the notify number, plus drop blank
  // capture-detail rows (the editor leaves an empty input when you click
  // "+ detail"); an empty string fails the schema's min(1)-per-item rule, and
  // an empty array fails min(1)-when-present.
  if (step.type === "voice_ai_intake") {
    const captureFields = (step.captureFields ?? []).map((f) => f.trim()).filter(Boolean);
    return {
      ...step,
      notifyE164: step.notifyRef ? undefined : step.notifyE164?.trim() || undefined,
      captureFields: captureFields.length > 0 ? captureFields : undefined
    };
  }
  // outbound_call: same blank-row + ref-wins cleanup on BOTH numbers; an empty
  // default toE164 is simply dropped (the entry point supplies the callee).
  if (step.type === "outbound_call") {
    const captureFields = (step.captureFields ?? []).map((f) => f.trim()).filter(Boolean);
    const toE164 = step.toRef ? undefined : step.toE164?.trim() || undefined;
    return {
      ...step,
      toE164,
      notifyE164: step.notifyRef ? undefined : step.notifyE164?.trim() || undefined,
      captureFields: captureFields.length > 0 ? captureFields : undefined
    };
  }
  // place_ai_call: ref-wins cleanup on the notify number and the transfer
  // target, blank capture-detail rows dropped (same conventions as
  // voice_ai_intake/outbound_call); a transfer with no target at all is
  // dropped so the semantic "no target" message never fires on an untouched
  // optional block.
  if (step.type === "place_ai_call") {
    const captureFields = (step.captureFields ?? []).map((f) => f.trim()).filter(Boolean);
    const transferTo = step.transfer?.toRef
      ? undefined
      : step.transfer?.toE164?.trim() || undefined;
    const transfer =
      step.transfer && (transferTo || step.transfer.toRef)
        ? {
            ...step.transfer,
            toE164: transferTo,
            preSmsTemplate: step.transfer.preSmsTemplate?.trim() || undefined
          }
        : undefined;
    return {
      ...step,
      notifyE164: step.notifyRef ? undefined : step.notifyE164?.trim() || undefined,
      transfer,
      captureFields: captureFields.length > 0 ? captureFields : undefined
    };
  }
  // send_sms / route_to_team: a picked ref supersedes the text alternatives so
  // the "exactly one recipient/agent" rules pass even with stale hidden state.
  // Group reply is its own recipient source and supersedes everything.
  if (step.type === "send_sms" && step.replyToGroup) {
    return { ...step, to: undefined, toAgentName: undefined, toRef: undefined };
  }
  if (step.type === "send_sms" && step.toRef) {
    return { ...step, to: undefined, toAgentName: undefined };
  }
  if (step.type === "route_to_team" && step.agentRef) {
    return { ...step, agentName: undefined };
  }
  if (step.type !== "browse_action") return step;
  if (step.forEachLink) {
    return {
      id: step.id,
      type: step.type,
      urlVar: step.urlVar,
      actions: step.actions,
      forEachLink: step.forEachLink,
      ...(step.forEachLinkMatchVar ? { forEachLinkMatchVar: step.forEachLinkMatchVar } : {}),
      ...(step.auth ? { auth: step.auth } : {}),
      ...(step.when ? { when: step.when } : {})
    };
  }
  // forEachLinkMatchVar is only valid alongside forEachLink. The editor hides
  // (but keeps) it when the selector is cleared, so drop a stale value here —
  // otherwise parseAiFlowDefinition rejects the otherwise-valid flow on save.
  if (step.forEachLinkMatchVar) {
    const { forEachLinkMatchVar: _drop, ...rest } = step;
    return rest;
  }
  return step;
}

function toDefinition(s: EditorState): AiFlowDefinition {
  const [primary, ...rest] = composeTriggerSet(s);
  return {
    version: 1,
    trigger: primary,
    ...(rest.length > 0 ? { triggers: rest } : {}),
    steps: s.steps.map(sanitizeStepForSave),
    ...(s.timeWindow ? { timeWindow: s.timeWindow } : {}),
    ...(s.dripIntervalMinutes && s.dripIntervalMinutes >= 1
      ? { drip: { intervalMinutes: Math.round(s.dripIntervalMinutes) } }
      : {}),
    options: {
      suppressDefaultReply: s.suppressDefaultReply,
      captureStepScreenshots: s.captureStepScreenshots
    }
  };
}

export function AiFlowsManager({
  businessId,
  businessType,
  initialFlows,
  initialEditId,
  initialAdaptDraft
}: {
  businessId: string;
  businessType?: string | null;
  initialFlows: AiFlowRow[];
  /** When set (e.g. from `?edit=<id>`), open that flow in the editor on mount. */
  initialEditId?: string | null;
  /** When true (`?adapt=1`), load the AI-adapted draft stashed in sessionStorage. */
  initialAdaptDraft?: boolean;
}) {
  const examples = getAiFlowExampleCopy(businessType);
  const [flows, setFlows] = useState<AiFlowRow[]>(initialFlows);
  const [sort, setSort] = usePersistentSort(
    "dashboard.aiflows.sort",
    { field: "last_run_at", dir: "desc" },
    AIFLOW_SORT_OPTIONS.map((o) => o.key)
  );
  const [editor, setEditor] = useState<EditorState | null>(() => {
    if (!initialEditId) return null;
    const row = initialFlows.find((f) => f.id === initialEditId);
    return row ? editorFromRow(row) : null;
  });
  // Snapshot of the editor as it was OPENED (or last saved): the flow editor
  // is dirty whenever the live state has drifted from it. `null` while the
  // editor holds an AI-generated draft — those are unsaved by definition
  // (leaving would throw away paid AI work). Tenant feedback: flow edits
  // were being silently lost by navigating away.
  const [editorBaseline, setEditorBaseline] = useState<string | null>(() => {
    if (!initialEditId) return null;
    const row = initialFlows.find((f) => f.id === initialEditId);
    // editorFromRow is deterministic, so this matches the editor initializer.
    return row ? JSON.stringify(editorFromRow(row)) : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  // Dirty = the draft drifted from its opened/saved snapshot, OR there's an
  // ungenerated "Generate with AI" description sitting in the box (typing a
  // prompt and leaving loses it just the same — the exact miss from Truly's
  // first test of this guard). The AI box only renders for NEW flows
  // (editor.id === null), so leftover prompt text must not dirty an edit
  // session where the box isn't even visible.
  const editorDirty =
    editor !== null &&
    (editorBaseline === null ||
      JSON.stringify(editor) !== editorBaseline ||
      (editor.id === null && aiPrompt.trim().length > 0));
  useUnsavedChangesWarning(editorDirty);
  // Best-effort salvage notes from the last AI generate (shown until the next).
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [emailConns, setEmailConns] = useState<EmailConnectionOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeEmailOption[]>([]);
  // Saved-person options for the dynamic-number pickers (live-resolved refs).
  const [rosterPeople, setRosterPeople] = useState<PickerPerson[]>([]);
  const [contactPeople, setContactPeople] = useState<PickerPerson[]>([]);
  const pickerPeople = [...rosterPeople, ...contactPeople];
  // Client-shareable business documents for the share_document step picker.
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  // Saved agents for the run_agent step picker.
  const [agents, setAgents] = useState<AgentOption[]>([]);
  // Run-now panel: which flow's panel is open, its input, and the last outcome.
  const [runFor, setRunFor] = useState<string | null>(null);
  const [runInput, setRunInput] = useState("");
  const [runNotice, setRunNotice] = useState<string | null>(null);
  // "Test with a contact": which row's test panel is open + its inputs.
  const [testFor, setTestFor] = useState<string | null>(null);
  const [testContact, setTestContact] = useState("");
  const [testInput, setTestInput] = useState("");
  // Place-call panel (outbound voice flows): which flow's panel is open + the
  // optional one-off callee override.
  const [callFor, setCallFor] = useState<string | null>(null);
  const [callTo, setCallTo] = useState("");
  // Visual | Classic editor preference. Visual (the GHL-style canvas) is the
  // default; the choice persists per browser. Hydration starts at the default
  // and the effect below applies the stored preference (a brief flash beats an
  // SSR/client mismatch).
  const [editorMode, setEditorModeState] = useState<"visual" | "classic">("visual");
  useEffect(() => {
    try {
      if (localStorage.getItem(EDITOR_MODE_STORAGE_KEY) === "classic") {
        setEditorModeState("classic");
      }
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);
  const setEditorMode = (mode: "visual" | "classic") => {
    setEditorModeState(mode);
    try {
      localStorage.setItem(EDITOR_MODE_STORAGE_KEY, mode);
    } catch {
      /* preference just won't persist */
    }
  };
  // The canvas-selected node: a step id, "trigger", or null (nothing open).
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // "Adapt with AI" hand-off: the library detail page stashes the adapted
  // definition in sessionStorage then navigates here with ?adapt=1. Load it
  // once into a fresh (disabled) editor for review, then clear the stash so a
  // refresh doesn't re-open it.
  useEffect(() => {
    if (!initialAdaptDraft) return;
    try {
      const raw = sessionStorage.getItem("aiflow_adapt_draft");
      if (!raw) return;
      const def = JSON.parse(raw) as AiFlowDefinition;
      if (def && Array.isArray(def.steps) && def.trigger) {
        // Only drop the stash once the (paid) draft parsed and validated, so a
        // malformed payload can still be retried from storage on reload.
        sessionStorage.removeItem("aiflow_adapt_draft");
        // Best-effort salvage notes from the adapt call, if any.
        try {
          const warnRaw = sessionStorage.getItem("aiflow_adapt_warnings");
          if (warnRaw) {
            sessionStorage.removeItem("aiflow_adapt_warnings");
            const warns = JSON.parse(warnRaw) as unknown;
            if (Array.isArray(warns)) {
              setAiWarnings(warns.filter((w): w is string => typeof w === "string"));
            }
          }
        } catch {
          /* warnings are advisory — never block the draft on them */
        }
        setEditor(editorFromDefinition(def, "Adapted automation"));
        // An adapted draft is unsaved AI work — dirty until saved.
        setEditorBaseline(null);
      }
    } catch {
      /* malformed/absent draft — fall back to the normal list view */
    }
  }, [initialAdaptDraft]);

  // Connected owner mailboxes for the send_email "From" dropdown (and the
  // quiet-hours email fallback). Best-effort: on any failure the dropdown
  // simply offers only the AI coworker's own mailbox.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/integrations/workspace?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: Array<{
            id: string;
            providerConfigKey: string;
            connectionId: string;
            metadata?: Record<string, unknown>;
          }>;
        };
        if (cancelled || !json.ok || !json.data) return;
        setEmailConns(
          json.data
            .filter((c) => EMAIL_CONNECTION_KEYS.includes(c.providerConfigKey))
            .map((c) => {
              // `provider_account_email` is the REAL account behind the OAuth
              // grant. `end_user_*` are the dashboard login that started the
              // connect session (identical for every account the owner
              // connects) — legacy-row fallbacks only.
              const m = c.metadata ?? {};
              const email =
                (typeof m.provider_account_email === "string" && m.provider_account_email) ||
                (typeof m.email === "string" && m.email) ||
                (typeof m.end_user_email === "string" && m.end_user_email) ||
                (typeof m.end_user_display_name === "string" && m.end_user_display_name) ||
                "";
              return {
                id: c.id,
                label: email ? `${c.providerConfigKey}: ${email}` : c.providerConfigKey
              };
            })
        );
      } catch {
        /* options stay empty; the dropdown still offers the AI coworker mailbox */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  // Team roster (ai_flow_team_members) for the cc/bcc "Add employee" picker
  // and the dynamic-number "saved contact" pickers. Best-effort: on any
  // failure the pickers simply hide and owners type values by hand.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/employees?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: {
            members?: Array<{
              id?: string;
              name?: string;
              email?: string | null;
              phone_e164?: string;
            }>;
          };
        };
        if (cancelled || !json.ok || !json.data?.members) return;
        setEmployees(
          json.data.members
            .filter((m): m is { name?: string; email: string } =>
              typeof m.email === "string" && m.email.length > 0
            )
            .map((m) => ({ name: typeof m.name === "string" ? m.name : m.email, email: m.email }))
        );
        setRosterPeople(
          json.data.members
            .filter(
              (m): m is { id: string; name?: string; phone_e164: string } =>
                typeof m.id === "string" && typeof m.phone_e164 === "string" && m.phone_e164.length > 0
            )
            .map((m) => ({
              source: "employee" as const,
              id: m.id,
              name: typeof m.name === "string" && m.name ? m.name : m.phone_e164,
              phone: m.phone_e164
            }))
        );
      } catch {
        /* picker stays empty; owners can still type cc/bcc addresses */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  // Client-shareable documents for the share_document step picker.
  // Best-effort: on failure the picker hides and the step shows a hint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/documents?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: {
            documents?: Array<{
              id?: string;
              title?: string;
              audience?: string;
              status?: string;
              expires_at?: string | null;
            }>;
          };
        };
        if (cancelled || !json.ok || !json.data?.documents) return;
        setDocuments(
          json.data.documents
            .filter(
              (d): d is { id: string; title: string; audience?: string; status?: string; expires_at?: string | null } =>
                typeof d.id === "string" &&
                typeof d.title === "string" &&
                d.status === "ready" &&
                d.audience !== "staff"
            )
            .map((d) => ({
              id: d.id,
              title: d.title,
              expired: Boolean(d.expires_at && Date.parse(d.expires_at) <= Date.now())
            }))
        );
      } catch {
        /* picker stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  // Saved agents for the run_agent step picker. Best-effort: on failure the
  // picker hides and the step shows a hint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/agents?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: { agents?: Array<{ id?: string; name?: string; enabled?: boolean }> };
        };
        if (cancelled || !json.ok || !json.data?.agents) return;
        setAgents(
          json.data.agents
            .filter(
              (a): a is { id: string; name: string; enabled?: boolean } =>
                typeof a.id === "string" && typeof a.name === "string"
            )
            .map((a) => ({ id: a.id, name: a.name, enabled: a.enabled !== false }))
        );
      } catch {
        /* picker stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  // Contact directory (contacts table) for the saved-contact number pickers.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/customers?businessId=${encodeURIComponent(businessId)}&limit=200`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: {
            customers?: Array<{ id?: string; customerE164?: string; displayName?: string | null }>;
          };
        };
        if (cancelled || !json.ok || !json.data?.customers) return;
        setContactPeople(
          json.data.customers
            .filter(
              (c): c is { id: string; customerE164: string; displayName?: string | null } =>
                typeof c.id === "string" && typeof c.customerE164 === "string" && c.customerE164.length > 0
            )
            .map((c) => ({
              source: "contact" as const,
              id: c.id,
              name: c.displayName?.trim() || c.customerE164,
              phone: c.customerE164
            }))
        );
      } catch {
        /* picker stays empty; owners can still type numbers by hand */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const patchStep = (index: number, patch: Record<string, unknown>) => {
    setEditor((e) =>
      e
        ? { ...e, steps: e.steps.map((st, i) => (i === index ? ({ ...st, ...patch } as FlowStep) : st)) }
        : e
    );
  };

  const moveStep = (index: number, dir: -1 | 1) => {
    setEditor((e) => {
      if (!e) return e;
      const j = index + dir;
      if (j < 0 || j >= e.steps.length) return e;
      const steps = [...e.steps];
      [steps[index], steps[j]] = [steps[j], steps[index]];
      return { ...e, steps };
    });
  };

  // ── Visual-canvas mutations: address steps by ID anywhere in the tree
  // (trunk, branch arms, else paths) via the immutable helpers in
  // src/lib/ai-flows/tree.ts. The classic form keeps flat-index editing above.
  const patchNodeById = (id: string, patch: Record<string, unknown>) => {
    setEditor((e) => (e ? { ...e, steps: patchStepById(e.steps, id, patch) } : e));
  };
  const insertNode = (container: StepContainerRef, index: number, type: FlowStep["type"]) => {
    const step = newStep(type, examples);
    setEditor((e) => (e ? { ...e, steps: insertStepAt(e.steps, container, index, step) } : e));
    setSelectedNode(step.id);
  };
  const moveNodeById = (id: string, dir: -1 | 1) => {
    setEditor((e) => (e ? { ...e, steps: moveStepById(e.steps, id, dir) } : e));
  };
  const duplicateNodeById = (id: string) => {
    setEditor((e) => {
      if (!e) return e;
      const entry = flattenForDisplay(e.steps).find((x) => x.step.id === id);
      if (!entry) return e;
      return {
        ...e,
        steps: insertStepAt(
          e.steps,
          entry.container,
          entry.indexInContainer + 1,
          duplicateOf(entry.step)
        )
      };
    });
  };
  const removeNodeById = (id: string) => {
    setEditor((e) => (e ? { ...e, steps: removeStepById(e.steps, id) } : e));
    setSelectedNode((cur) => (cur === id ? null : cur));
  };

  const reload = async () => {
    const res = await fetch(`/api/aiflows?businessId=${encodeURIComponent(businessId)}`, {
      cache: "no-store"
    });
    const json = (await res.json()) as { ok: boolean; data?: AiFlowRow[] };
    if (json.ok && json.data) setFlows(json.data);
  };

  const save = async () => {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      const definition = toDefinition(editor);
      const payload = { businessId, name: editor.name, enabled: editor.enabled, definition };
      const res = editor.id
        ? await fetch(`/api/aiflows/${editor.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          })
        : await fetch(`/api/aiflows`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Save failed");
        return;
      }
      setEditor(null);
      setEditorBaseline(null);
      setAiWarnings([]);
      setAiPrompt("");
      setSelectedNode(null);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/aiflows/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  /** Create a disabled copy of an existing flow ("Name (copy)"). */
  const duplicateFlow = async (row: AiFlowRow) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/aiflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: `${row.name} (copy)`.slice(0, 120),
          enabled: false,
          definition: row.definition
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Duplicate failed");
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  /** Start one manual run (any trigger channel; the flow must be enabled). */
  const runNow = async (row: AiFlowRow) => {
    setBusy(true);
    setRunNotice(null);
    try {
      const res = await fetch(`/api/aiflows/${row.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, input: runInput.trim() || undefined })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setRunNotice(json.error?.message ?? "Run failed to start");
        return;
      }
      setRunNotice("Run queued; see View runs for progress.");
      setRunInput("");
      setRunFor(null);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Start a TEST run: real engine, simulated side effects, waits resolve
   * instantly. Works on disabled flows (testing a draft is the point).
   */
  const testRun = async (row: AiFlowRow) => {
    setBusy(true);
    setRunNotice(null);
    try {
      const res = await fetch(`/api/aiflows/${row.id}/test-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          contactE164: testContact.trim(),
          input: testInput.trim() || undefined
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setRunNotice(json.error?.message ?? "Test failed to start");
        return;
      }
      setRunNotice(
        "Test run queued — nothing is actually sent. See View runs for what each step WOULD have done."
      );
      setTestInput("");
      setTestFor(null);
    } finally {
      setBusy(false);
    }
  };

  /** Place one outbound call for a voice flow with direction "outbound". */
  const placeCall = async (row: AiFlowRow) => {
    setBusy(true);
    setRunNotice(null);
    try {
      const res = await fetch(`/api/aiflows/${row.id}/place-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, toE164: callTo.trim() || undefined })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { to?: string };
        error?: { message: string };
      };
      if (!json.ok) {
        setRunNotice(json.error?.message ?? "Could not place the call");
        return;
      }
      setRunNotice(`Calling ${json.data?.to ?? "the number"} now…`);
      setCallTo("");
      setCallFor(null);
    } finally {
      setBusy(false);
    }
  };

  // Timestamps render in the OWNER's timezone, so they must not be part of
  // the server-rendered markup (the server would bake in ITS zone and
  // mismatch on hydration) — the status-times span mounts client-side only.
  const [clockMounted, setClockMounted] = useState(false);
  useEffect(() => setClockMounted(true), []);

  /** "Jul 10, 3:12 PM" — compact stamp for the list row's status times. */
  const shortWhen = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  };

  const toggleEnabled = async (row: AiFlowRow) => {
    await fetch(`/api/aiflows/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, enabled: !row.enabled })
    });
    await reload();
  };

  const generateWithAi = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    setError(null);
    setAiWarnings([]);
    try {
      const res = await fetch(`/api/aiflows/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, description: aiPrompt })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { definition: AiFlowDefinition; warnings?: string[] };
        error?: { message: string };
      };
      if (!json.ok || !json.data) {
        setError(json.error?.message ?? "AI generation failed");
        return;
      }
      // Best-effort salvage warnings: the draft loaded, but parts were
      // repaired/removed — tell the owner exactly what to double-check.
      const warnings = json.data.warnings ?? [];
      setAiWarnings(warnings);
      const def = json.data.definition;
      setEditor((e) => ({
        id: e?.id ?? null,
        name: e?.name || "New automation",
        // A salvaged draft (warnings present) must be REVIEWED before it can
        // run: load it disabled, like the adapt hand-off does.
        enabled: warnings.length > 0 ? false : (e?.enabled ?? true),
        suppressDefaultReply: def.options?.suppressDefaultReply ?? false,
        captureStepScreenshots: e?.captureStepScreenshots ?? def.options?.captureStepScreenshots ?? false,
        ...triggerToEditorFields(def.trigger),
        extraTriggers: def.triggers ?? [],
        editingTriggerIndex: 0,
        timeWindow: def.timeWindow ?? null,
        dripIntervalMinutes: def.drip?.intervalMinutes ?? null,
        steps: def.steps
      }));
      // A generated draft is unsaved AI work — dirty until saved.
      setEditorBaseline(null);
    } finally {
      setAiBusy(false);
    }
  };

  if (editor) {
    // A flow with branch steps can't round-trip through the flat classic form,
    // so it always edits visually regardless of the stored preference.
    const flowHasBranch = hasBranchStep(editor.steps);
    const mode: "visual" | "classic" = flowHasBranch ? "visual" : editorMode;
    const selectedStep =
      mode === "visual" && selectedNode && selectedNode !== "trigger"
        ? findStepById(editor.steps, selectedNode)
        : null;
    const canvasAddable =
      editor.channel === "voice"
        ? editor.voiceDirection === "outbound"
          ? OUTBOUND_VOICE_STEP_TYPES
          : INBOUND_VOICE_STEP_TYPES
        : VISUAL_BATCH_STEP_TYPES;
    return (
      <Card className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-parchment">
            {editor.id ? "Edit AiFlow" : "New AiFlow"}
          </h2>
          <div className="flex items-center gap-3">
            <div className="flex rounded-md border border-parchment/15 p-0.5 text-xs">
              {(["visual", "classic"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setEditorMode(m)}
                  disabled={m === "classic" && flowHasBranch}
                  title={
                    m === "classic" && flowHasBranch
                      ? "This flow uses branching — edit it in Visual."
                      : undefined
                  }
                  className={`rounded px-2.5 py-1 font-medium transition-colors ${
                    mode === m
                      ? "bg-signal-teal/20 text-signal-teal"
                      : "text-parchment/50 hover:text-parchment"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {m === "visual" ? "Visual" : "Classic"}
                </button>
              ))}
            </div>
            {editorDirty && !busy && (
              <span className="text-xs text-amber-300/80">Unsaved changes</span>
            )}
            <button
              onClick={() => {
                // Closing throws away edits — make that a decision, not an
                // accident (the browser prompt only covers page unloads).
                if (
                  editorDirty &&
                  !window.confirm("Discard unsaved changes to this automation?")
                ) {
                  return;
                }
                setEditor(null);
                setEditorBaseline(null);
                // Salvage notes and the AI description belong to the draft
                // being abandoned.
                setAiWarnings([]);
                setAiPrompt("");
                setSelectedNode(null);
              }}
              className="text-sm text-parchment/50 hover:text-parchment"
            >
              Cancel
            </button>
          </div>
        </div>

        {error && (
          <p className="rounded-md border border-spark-orange/40 bg-spark-orange/5 px-3 py-2 text-sm text-spark-orange">
            {error}
          </p>
        )}

        {aiWarnings.length > 0 && (
          <div className="rounded-md border border-amber-300/40 bg-amber-300/5 px-3 py-2 text-sm text-amber-200">
            <p className="font-medium">
              Loaded a best-effort draft — a few things need your eyes:
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs space-y-0.5">
              {aiWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <label className={labelClass}>Name</label>
          <input
            className={inputClass}
            value={editor.name}
            onChange={(ev) => setEditor({ ...editor, name: ev.target.value })}
            placeholder={examples.namePlaceholder}
          />
        </div>

        {editor.id === null && (
          <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-4 space-y-3">
            <div className="flex items-center gap-2 text-parchment/70">
              <Sparkles className="h-4 w-4 text-signal-teal" />
              <span className="text-sm font-medium">Generate with AI</span>
            </div>
            <p className="text-[11px] text-parchment/40">
              Describe what you want in plain English and we’ll draft the steps for you. You can
              edit everything afterward.
            </p>
            <textarea
              className={inputClass}
              rows={2}
              value={aiPrompt}
              onChange={(ev) => setAiPrompt(ev.target.value)}
              placeholder={examples.aiPromptPlaceholder}
            />
            <button
              onClick={generateWithAi}
              disabled={aiBusy}
              className="rounded-md bg-signal-teal/20 px-3 py-1.5 text-sm text-signal-teal hover:bg-signal-teal/30 disabled:opacity-50"
            >
              {aiBusy ? "Generating…" : "Generate steps"}
            </button>
          </div>
        )}

        {mode === "visual" && (
          <section className="space-y-3">
            <p className="text-[11px] text-parchment/40">
              Click the trigger or a step to configure it; use the + between steps to add one.
              Tip: type something like {`{{vars.${examples.tipVar}}}`} in a message to reuse a
              detail an earlier step found.
            </p>
            <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
              <AiFlowCanvas
                trigger={editorTrigger(editor)}
                steps={editor.steps}
                selectedId={selectedNode ?? undefined}
                addableTypes={canvasAddable}
                onSelectStep={(id) => setSelectedNode((cur) => (cur === id ? null : id))}
                onSelectTrigger={() =>
                  setSelectedNode((cur) => (cur === "trigger" ? null : "trigger"))
                }
                onInsertStep={insertNode}
                onMoveStep={moveNodeById}
                onDuplicateStep={duplicateNodeById}
                onRemoveStep={removeNodeById}
              />
            </div>
            {selectedStep && (
              <div className="rounded-md border border-signal-teal/25 bg-deep-ink/20 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-parchment">
                    {STEP_TYPE_LABELS[selectedStep.type]}
                  </span>
                  <button
                    onClick={() => setSelectedNode(null)}
                    className="text-xs text-parchment/50 hover:text-parchment"
                  >
                    Close
                  </button>
                </div>
                <p className="text-[11px] text-parchment/40">
                  {STEP_TYPE_HELP[selectedStep.type]}
                </p>
                {selectedStep.type === "branch" ? (
                  <BranchFields
                    step={selectedStep}
                    earlierVars={[
                      ...varsInScopeBefore(editor.steps, selectedStep.id),
                      ...ENGINE_PROVIDED_VARS
                    ]}
                    patch={(p) => patchNodeById(selectedStep.id, p)}
                    examples={examples}
                  />
                ) : (
                  <StepFields
                    step={selectedStep}
                    index={0}
                    patchStep={(_i, p) => patchNodeById(selectedStep.id, p)}
                    emailConns={emailConns}
                    employees={employees}
                    people={pickerPeople}
                    documents={documents}
                    agents={agents}
                    examples={examples}
                  />
                )}
                {!VOICE_STEP_TYPE_SET.has(selectedStep.type) && (
                  <WhenEditor
                    step={selectedStep}
                    index={0}
                    earlierVars={[
                      ...varsInScopeBefore(editor.steps, selectedStep.id),
                      ...ENGINE_PROVIDED_VARS
                    ]}
                    patchStep={(_i, p) => patchNodeById(selectedStep.id, p)}
                    examples={examples}
                  />
                )}
              </div>
            )}
          </section>
        )}

        {(mode === "classic" || selectedNode === "trigger") && (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">
            {editor.extraTriggers.length > 0 ? "Triggers" : "Trigger"}
          </h3>
          <p className="text-[11px] text-parchment/40">
            {editor.extraTriggers.length > 0
              ? "This workflow starts when ANY of these triggers fires. Click one to edit it."
              : "The trigger is what kicks off this workflow; pick how it should start below."}
          </p>
          {(editor.extraTriggers.length > 0 || editor.channel !== "voice") && (
            <div className="flex flex-wrap items-center gap-2">
              {composeTriggerSet(editor).map((t, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${
                    i === editor.editingTriggerIndex
                      ? "border-signal-teal/60 bg-signal-teal/10 text-parchment"
                      : "border-parchment/15 text-parchment/60"
                  }`}
                >
                  <button onClick={() => setEditor(selectTriggerForEdit(editor, i))}>
                    {CHANNEL_LABELS[t.channel]}
                  </button>
                  {composeTriggerSet(editor).length > 1 && (
                    <button
                      onClick={() => {
                        const full = composeTriggerSet(editor);
                        full.splice(i, 1);
                        const next: EditorState = {
                          ...editor,
                          ...triggerToEditorFields(full[0]),
                          extraTriggers: full.slice(1),
                          editingTriggerIndex: 0
                        };
                        setEditor(next);
                      }}
                      className="text-parchment/40 hover:text-spark-orange"
                      aria-label="Remove this trigger"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              {composeTriggerSet(editor).length < 5 && editor.channel !== "voice" && (
                <button
                  onClick={() => {
                    // Append a fresh manual trigger and select it for editing.
                    const full = composeTriggerSet(editor);
                    full.push({ channel: "manual" });
                    const next: EditorState = {
                      ...editor,
                      ...triggerToEditorFields(full[full.length - 1]),
                      extraTriggers: full.slice(0, -1),
                      editingTriggerIndex: full.length - 1
                    };
                    setEditor(next);
                  }}
                  className="text-xs text-signal-teal hover:underline"
                >
                  + Add another trigger
                </button>
              )}
            </div>
          )}
          <div>
            <label className={labelClass}>Starts when</label>
            <select
              className={inputClass}
              value={editor.channel}
              onChange={(ev) =>
                setEditor({ ...editor, channel: ev.target.value as FlowTrigger["channel"] })
              }
            >
              {(Object.keys(CHANNEL_LABELS) as FlowTrigger["channel"][])
                // Voice runs on the live call path and stays single-trigger,
                // so it can't be one of several triggers.
                .filter((c) => c !== "voice" || editor.extraTriggers.length === 0)
                .map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABELS[c]}
                  </option>
                ))}
            </select>
          </div>
          {editor.channel === "manual" && (
            <p className="text-xs text-parchment/50">
              This workflow only starts from the Run now button on the AiFlows list (you can
              pass it a link or text when starting it).
            </p>
          )}
          {editor.channel === "schedule" && (
            <div className="space-y-2">
              <select
                className={inputClass}
                value={editor.scheduleMode}
                onChange={(ev) =>
                  setEditor({ ...editor, scheduleMode: ev.target.value as "daily" | "every" })
                }
              >
                <option value="daily">Daily at a time</option>
                <option value="every">Every N minutes</option>
              </select>
              {editor.scheduleMode === "daily" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClass}>Time (24h HH:MM)</label>
                    <input
                      className={inputClass}
                      value={editor.scheduleTime}
                      onChange={(ev) => setEditor({ ...editor, scheduleTime: ev.target.value })}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Time zone</label>
                    <input
                      className={inputClass}
                      value={editor.scheduleTimezone}
                      onChange={(ev) => setEditor({ ...editor, scheduleTimezone: ev.target.value })}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className={labelClass}>Days (default: every day)</label>
                    <div className="flex flex-wrap gap-2">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, di) => (
                        <label key={d} className="flex items-center gap-1 text-xs text-parchment/70">
                          <input
                            type="checkbox"
                            checked={editor.scheduleDays.includes(di)}
                            onChange={(ev) =>
                              setEditor({
                                ...editor,
                                scheduleDays: ev.target.checked
                                  ? [...editor.scheduleDays, di]
                                  : editor.scheduleDays.filter((x) => x !== di)
                              })
                            }
                          />
                          {d}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <label className={labelClass}>Every N minutes (min 15)</label>
                  <input
                    type="number"
                    className={inputClass}
                    value={editor.scheduleEvery}
                    onChange={(ev) =>
                      setEditor({ ...editor, scheduleEvery: Number(ev.target.value) || 60 })
                    }
                  />
                </div>
              )}
            </div>
          )}
          {editor.channel === "email" && (
            <div>
              <label className={labelClass}>Watch mailbox</label>
              <select
                className={inputClass}
                value={editor.emailConnectionId}
                onChange={(ev) => setEditor({ ...editor, emailConnectionId: ev.target.value })}
              >
                <option value="">Select a connected mailbox…</option>
                {emailConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
                {editor.emailConnectionId &&
                  !emailConns.some((c) => c.id === editor.emailConnectionId) && (
                    <option value={editor.emailConnectionId}>
                      connected mailbox (disconnected?)
                    </option>
                  )}
              </select>
              <p className="mt-1 text-[11px] text-parchment/40">
                Connect another mailbox under Settings → Integrations to see it here.
              </p>
            </div>
          )}
          {editor.channel === "tenant_email" && (
            <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
              <p className="text-[11px] text-parchment/60">
                This runs when your AI coworker&apos;s own email address receives a message. The
                address is shown (and can be personalized on Standard and above) under Settings →
                Mailbox. No mailbox connection is needed.
              </p>
            </div>
          )}
          {editor.channel === "webhook" && (
            <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3 space-y-1.5">
              <p className="text-[11px] text-parchment/60">
                This runs when an outside tool (Zapier, Make.com, or any API client) sends an
                event to your coworker&apos;s webhook address. Point the tool at{" "}
                <code className="font-mono text-signal-teal break-all">
                  POST /api/public/v1/flow-events
                </code>{" "}
                with an API key from the dashboard Integrations page. Great for capturing leads
                from Meta (Facebook/Instagram) lead ads and other lead sources.
              </p>
              <p className="text-[11px] text-parchment/50">
                Step-by-step setup:{" "}
                <Link
                  href="/dashboard/aiflows/guides/meta-leads"
                  className="text-signal-teal hover:underline"
                >
                  How to capture Meta ad leads
                </Link>
              </p>
            </div>
          )}
          {editor.channel === "calendar" && (
            <div className="space-y-2">
              <div>
                <label className={labelClass}>Run when</label>
                <select
                  className={inputClass}
                  value={editor.calendarOn}
                  onChange={(ev) =>
                    setEditor({
                      ...editor,
                      calendarOn:
                        ev.target.value === "event_start"
                          ? "event_start"
                          : ev.target.value === "event_end"
                            ? "event_end"
                            : ev.target.value === "event_canceled"
                              ? "event_canceled"
                              : "event_created"
                    })
                  }
                >
                  <option value="event_created">A new event is added to the calendar</option>
                  <option value="event_start">An event is about to start</option>
                  <option value="event_end">An event has ended</option>
                  <option value="event_canceled">An event is canceled</option>
                </select>
              </div>
              {editor.calendarOn === "event_start" && (
                <div>
                  <label className={labelClass}>How long before the event (minutes, min 1)</label>
                  <input
                    type="number"
                    min={1}
                    className={inputClass}
                    value={editor.calendarLeadMinutes}
                    onChange={(ev) =>
                      setEditor({
                        ...editor,
                        // The due window is [start - lead, start), so zero can
                        // never fire; clamp instead of saving a dead flow.
                        calendarLeadMinutes: Math.max(1, Number(ev.target.value) || 1)
                      })
                    }
                  />
                </div>
              )}
              {editor.calendarOn === "event_end" && (
                <div>
                  <label className={labelClass}>
                    How long after the event ends (minutes, 0 = right away)
                  </label>
                  <input
                    type="number"
                    min={0}
                    className={inputClass}
                    value={editor.calendarFollowMinutes}
                    onChange={(ev) =>
                      setEditor({
                        ...editor,
                        calendarFollowMinutes: Math.max(0, Number(ev.target.value) || 0)
                      })
                    }
                  />
                  <p className="mt-1 text-[11px] text-parchment/40">
                    Anchored to the event&apos;s actual end time — a 30-minute and a 2-hour
                    appointment both follow up on schedule, no guessed wait needed.
                  </p>
                </div>
              )}
              <div>
                <label className={labelClass}>Which calendar</label>
                <select
                  className={inputClass}
                  value={editor.calendarSource}
                  onChange={(ev) =>
                    setEditor({
                      ...editor,
                      calendarSource:
                        ev.target.value === "primary" || ev.target.value === "shared"
                          ? ev.target.value
                          : "both"
                    })
                  }
                >
                  <option value="both">Both: my calendar + the NewCoworker calendar</option>
                  <option value="primary">My connected calendar</option>
                  <option value="shared">The shared NewCoworker calendar</option>
                </select>
              </div>
              <p className="text-[11px] text-parchment/40">
                Uses the calendar account connected under Settings → Integrations (the same one
                bookings go to). The shared NewCoworker calendar is where your AI coworker books
                appointments; it&apos;s created with the first booking. Conditions below match the
                event&apos;s title, description, location, and attendees.
              </p>
            </div>
          )}
          {editor.channel === "contact_created" && (
            <p className="text-[11px] text-parchment/40">
              Runs when a NEW contact lands on your Contacts page — added by hand, imported,
              or filed by another workflow&apos;s &quot;Save / update a customer contact&quot; step.
              Conditions below match the contact&apos;s name, phone, email, and tags.
            </p>
          )}
          {editor.channel === "tag_changed" && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Tag to watch (empty = any tag)</label>
                  <input
                    className={inputClass}
                    value={editor.tagChangedTag}
                    placeholder="Appointment Scheduled"
                    onChange={(ev) => setEditor({ ...editor, tagChangedTag: ev.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass}>When it is</label>
                  <select
                    className={inputClass}
                    value={editor.tagChangedChange}
                    onChange={(ev) =>
                      setEditor({
                        ...editor,
                        tagChangedChange: ev.target.value === "removed" ? "removed" : "added"
                      })
                    }
                  >
                    <option value="added">Added to the contact</option>
                    <option value="removed">Removed from the contact</option>
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-parchment/40">
                Fires for dashboard tag edits AND tags other workflows set — chain workflows
                off your lead statuses. A workflow never retriggers itself through its own tag
                changes.
              </p>
            </div>
          )}
          {editor.channel === "owner_assigned" && (
            <p className="text-[11px] text-parchment/40">
              Runs when a contact gets an owning team member — a teammate claims the lead, or
              you assign one on the contact page.
            </p>
          )}
          {editor.channel === "birthday" && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Send at (24h HH:MM)</label>
                  <input
                    className={inputClass}
                    value={editor.birthdayTime}
                    placeholder="09:00"
                    onChange={(ev) => setEditor({ ...editor, birthdayTime: ev.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass}>Time zone (empty = business timezone)</label>
                  <input
                    className={inputClass}
                    value={editor.birthdayTimezone}
                    placeholder="America/Phoenix"
                    onChange={(ev) =>
                      setEditor({ ...editor, birthdayTimezone: ev.target.value })
                    }
                  />
                </div>
              </div>
              <p className="text-[11px] text-parchment/40">
                Fires once per year for every contact whose birthday (set on their contact
                page) is today. Contacts without a birthday never fire.
              </p>
            </div>
          )}
          {editor.channel === "voice" && (
            <div className="space-y-2">
              <div>
                <label className={labelClass}>Direction</label>
                <select
                  className={inputClass}
                  value={editor.voiceDirection}
                  onChange={(ev) =>
                    setEditor({
                      ...editor,
                      voiceDirection: ev.target.value === "outbound" ? "outbound" : "inbound"
                    })
                  }
                >
                  <option value="inbound">Inbound: a call comes in</option>
                  <option value="outbound">Outbound: you place a call</option>
                </select>
              </div>
              {editor.voiceDirection === "inbound" ? (
                <>
                  <ContactRefPicker
                    label="Caller number (E.164, e.g. +14155551234)"
                    placeholder="+14155551234"
                    textValue={editor.voiceFromE164}
                    refValue={editor.voiceFromRef ?? undefined}
                    people={pickerPeople}
                    onChangeText={(v) => setEditor({ ...editor, voiceFromE164: v.trim() })}
                    onChangeRef={(ref) => setEditor({ ...editor, voiceFromRef: ref ?? null })}
                    help="Calls from this person fire the flow."
                  />
                  <p className="text-[11px] text-parchment/40">
                    When a call comes in from this number, the steps below route it in real time: ring
                    people in order, then optionally hand off to your AI, or connect straight to one
                    number. Voice flows run on the call as it happens, so Run now and the batch
                    conditions don&apos;t apply.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[11px] text-parchment/40">
                    An outbound flow places a call when you press Place call on the flow. Add a single
                    Place an outbound call step below; when the callee answers, the AI talks to them,
                    captures the details, and texts you a summary. Voice budget is checked first, so an
                    over-budget account can&apos;t place AI calls.
                  </p>
                  <label className="flex items-center gap-2 text-xs text-parchment/70">
                    <input
                      type="checkbox"
                      checked={editor.voiceOutboundScheduled}
                      onChange={(ev) =>
                        setEditor({ ...editor, voiceOutboundScheduled: ev.target.checked })
                      }
                    />
                    Auto-dial on a schedule (otherwise place calls manually)
                  </label>
                  {editor.voiceOutboundScheduled && (
                    <div className="space-y-2 rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
                      <select
                        className={inputClass}
                        value={editor.scheduleMode}
                        onChange={(ev) =>
                          setEditor({ ...editor, scheduleMode: ev.target.value as "daily" | "every" })
                        }
                      >
                        <option value="daily">Daily at a time</option>
                        <option value="every">Every N minutes</option>
                      </select>
                      {editor.scheduleMode === "daily" ? (
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className={labelClass}>Time (24h HH:MM)</label>
                            <input
                              className={inputClass}
                              value={editor.scheduleTime}
                              onChange={(ev) =>
                                setEditor({ ...editor, scheduleTime: ev.target.value })
                              }
                            />
                          </div>
                          <div>
                            <label className={labelClass}>Time zone</label>
                            <input
                              className={inputClass}
                              value={editor.scheduleTimezone}
                              onChange={(ev) =>
                                setEditor({ ...editor, scheduleTimezone: ev.target.value })
                              }
                            />
                          </div>
                          <div className="col-span-2">
                            <label className={labelClass}>Days (default: every day)</label>
                            <div className="flex flex-wrap gap-2">
                              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, di) => (
                                <label
                                  key={d}
                                  className="flex items-center gap-1 text-xs text-parchment/70"
                                >
                                  <input
                                    type="checkbox"
                                    checked={editor.scheduleDays.includes(di)}
                                    onChange={(ev) =>
                                      setEditor({
                                        ...editor,
                                        scheduleDays: ev.target.checked
                                          ? [...editor.scheduleDays, di]
                                          : editor.scheduleDays.filter((x) => x !== di)
                                      })
                                    }
                                  />
                                  {d}
                                </label>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label className={labelClass}>Every N minutes (min 15)</label>
                          <input
                            type="number"
                            className={inputClass}
                            value={editor.scheduleEvery}
                            onChange={(ev) =>
                              setEditor({ ...editor, scheduleEvery: Number(ev.target.value) || 60 })
                            }
                          />
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {editor.channel === "sms" && (
            <div>
              <label className={labelClass}>Combine related texts that arrive within (minutes)</label>
              <input
                type="number"
                className={inputClass}
                value={editor.correlationWindowMinutes}
                onChange={(ev) =>
                  setEditor({ ...editor, correlationWindowMinutes: Number(ev.target.value) || 0 })
                }
              />
              <p className="mt-1 text-[11px] text-parchment/40">
                If a lead sends several texts in a row, wait this long to group them together
                before starting the workflow.
              </p>
            </div>
          )}
          {(editor.channel === "sms" ||
            editor.channel === "email" ||
            editor.channel === "tenant_email" ||
            editor.channel === "webhook" ||
            editor.channel === "calendar" ||
            editor.channel === "contact_created" ||
            editor.channel === "tag_changed" ||
            editor.channel === "owner_assigned" ||
            editor.channel === "birthday") &&
            editor.conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                className={inputClass}
                value={c.type}
                onChange={(ev) => {
                  const type = ev.target.value as TriggerCondition["type"];
                  const next: TriggerCondition =
                    type === "has_url" ? { type } : { type, value: ("value" in c ? c.value : "") ?? "" };
                  setEditor({
                    ...editor,
                    conditions: editor.conditions.map((x, xi) => (xi === i ? next : x))
                  });
                }}
              >
                {TRIGGER_CONDITION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CONDITION_LABELS[t]}
                  </option>
                ))}
              </select>
              {c.type === "from_matches" ? (
                // Sender can be typed text OR a saved person whose live
                // identity (phone + email) is matched at event time.
                <ContactRefPicker
                  label=""
                  placeholder="text / sender"
                  textValue={c.value ?? ""}
                  refValue={c.ref}
                  people={pickerPeople}
                  onChangeText={(v) =>
                    setEditor({
                      ...editor,
                      conditions: editor.conditions.map((x, xi) =>
                        xi === i ? ({ ...x, value: v, ref: undefined } as TriggerCondition) : x
                      )
                    })
                  }
                  onChangeRef={(ref) =>
                    setEditor({
                      ...editor,
                      conditions: editor.conditions.map((x, xi) =>
                        // Spread so options like caseInsensitive survive the
                        // switch to a saved-person sender.
                        xi === i ? ({ ...x, ref, value: undefined } as TriggerCondition) : x
                      )
                    })
                  }
                />
              ) : (
                c.type !== "has_url" && (
                  <input
                    className={inputClass}
                    value={c.value ?? ""}
                    onChange={(ev) =>
                      setEditor({
                        ...editor,
                        conditions: editor.conditions.map((x, xi) =>
                          xi === i ? ({ ...x, value: ev.target.value } as TriggerCondition) : x
                        )
                      })
                    }
                    placeholder="text / pattern / sender"
                  />
                )
              )}
              <button
                onClick={() =>
                  setEditor({
                    ...editor,
                    conditions: editor.conditions.filter((_, xi) => xi !== i)
                  })
                }
                className="text-parchment/40 hover:text-spark-orange"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {(editor.channel === "sms" ||
            editor.channel === "email" ||
            editor.channel === "tenant_email" ||
            editor.channel === "webhook" ||
            editor.channel === "calendar" ||
            editor.channel === "contact_created" ||
            editor.channel === "tag_changed" ||
            editor.channel === "owner_assigned" ||
            editor.channel === "birthday") && (
            <button
              onClick={() =>
                setEditor({ ...editor, conditions: [...editor.conditions, { type: "contains", value: "" }] })
              }
              className="inline-flex items-center gap-1 text-sm text-signal-teal hover:underline"
            >
              <Plus className="h-3 w-3" /> Add condition
            </button>
          )}
        </section>
        )}

        {mode === "classic" && (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">Steps</h3>
          <p className="text-[11px] text-parchment/40">
            Steps run top to bottom. Tip: type something like {`{{vars.${examples.tipVar}}}`} to reuse a
            detail an earlier step found, or {"{{trigger.url}}"} for the link from the text that
            started the workflow.
          </p>
          {editor.steps.map((step, i) => (
            <div key={step.id} className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-parchment">
                  {i + 1}. {STEP_TYPE_LABELS[step.type]}
                </span>
                <div className="flex items-center gap-2 text-parchment/40">
                  <button onClick={() => moveStep(i, -1)} aria-label="Move up">
                    <ArrowUp className="h-4 w-4 hover:text-parchment" />
                  </button>
                  <button onClick={() => moveStep(i, 1)} aria-label="Move down">
                    <ArrowDown className="h-4 w-4 hover:text-parchment" />
                  </button>
                  <button
                    onClick={() =>
                      setEditor({
                        ...editor,
                        steps: [
                          ...editor.steps.slice(0, i + 1),
                          duplicateOf(step),
                          ...editor.steps.slice(i + 1)
                        ]
                      })
                    }
                    aria-label="Duplicate step"
                    title="Duplicate step"
                  >
                    <Copy className="h-4 w-4 hover:text-signal-teal" />
                  </button>
                  <button
                    onClick={() =>
                      setEditor({ ...editor, steps: editor.steps.filter((_, xi) => xi !== i) })
                    }
                    aria-label="Remove step"
                  >
                    <Trash2 className="h-4 w-4 hover:text-spark-orange" />
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-parchment/40">{STEP_TYPE_HELP[step.type]}</p>
              <StepFields
                step={step}
                index={i}
                patchStep={patchStep}
                emailConns={emailConns}
                employees={employees}
                people={pickerPeople}
                documents={documents}
                agents={agents}
                examples={examples}
              />
              {/* Voice steps have no `when` guard (they run on the real-time call
                  path, not the var-producing batch engine), so hide it for them. */}
              {!VOICE_STEP_TYPE_SET.has(step.type) && (
                <WhenEditor
                  step={step}
                  index={i}
                  earlierVars={[...varsProducedBefore(editor.steps, i), ...ENGINE_PROVIDED_VARS]}
                  patchStep={patchStep}
                  examples={examples}
                />
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {(editor.channel === "voice"
              ? editor.voiceDirection === "outbound"
                ? OUTBOUND_VOICE_STEP_TYPES
                : INBOUND_VOICE_STEP_TYPES
              : NON_VOICE_STEP_TYPES
            ).map((t) => (
              <button
                key={t}
                onClick={() => setEditor({ ...editor, steps: [...editor.steps, newStep(t, examples)] })}
                title={STEP_TYPE_HELP[t]}
                className="inline-flex items-center gap-1 rounded-md border border-parchment/15 px-2 py-1 text-xs text-parchment/70 hover:border-signal-teal hover:text-signal-teal"
              >
                <Plus className="h-3 w-3" /> {STEP_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </section>
        )}

        <TimeWindowFields
          value={editor.timeWindow}
          onChange={(tw) => setEditor({ ...editor, timeWindow: tw })}
        />

        <section className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-parchment/70">
            <input
              type="checkbox"
              checked={editor.dripIntervalMinutes !== null}
              onChange={(ev) =>
                setEditor({
                  ...editor,
                  dripIntervalMinutes: ev.target.checked ? 5 : null
                })
              }
            />
            Drip: space out bulk runs instead of sending all at once
          </label>
          {editor.dripIntervalMinutes !== null && (
            <div className="pl-6">
              <label className={labelClass}>Minutes between runs (1–1440)</label>
              <input
                type="number"
                min={1}
                max={1440}
                className={inputClass}
                value={editor.dripIntervalMinutes}
                onChange={(ev) =>
                  setEditor({
                    ...editor,
                    dripIntervalMinutes: Math.min(1440, Math.max(1, Number(ev.target.value) || 1))
                  })
                }
              />
              <p className="mt-1 text-[11px] text-parchment/40">
                When many leads enroll at once (an import, a webhook burst), runs start this
                far apart so the flow trickles instead of bursting. A single inbound text
                still runs immediately.
              </p>
            </div>
          )}
        </section>

        <section className="space-y-2">
          {editor.channel === "sms" && (
            <label className="flex items-center gap-2 text-sm text-parchment/70">
              <input
                type="checkbox"
                checked={editor.suppressDefaultReply}
                onChange={(ev) => setEditor({ ...editor, suppressDefaultReply: ev.target.checked })}
              />
              Suppress the normal Coworker reply when this flow matches
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-parchment/70">
            <input
              type="checkbox"
              checked={editor.captureStepScreenshots}
              onChange={(ev) =>
                setEditor({ ...editor, captureStepScreenshots: ev.target.checked })
              }
            />
            Capture screenshots of each browser step (for debugging failures)
          </label>
          <label className="flex items-center gap-2 text-sm text-parchment/70">
            <input
              type="checkbox"
              checked={editor.enabled}
              onChange={(ev) => setEditor({ ...editor, enabled: ev.target.checked })}
            />
            Enabled
          </label>
        </section>

        <div className="flex items-center justify-end gap-3">
          {editorDirty && !busy && (
            <span className="text-xs text-amber-300/80">Unsaved changes</span>
          )}
          <button
            onClick={save}
            disabled={busy}
            className="rounded-md bg-signal-teal px-4 py-2 text-sm font-semibold text-deep-ink hover:bg-signal-teal/90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save AiFlow"}
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-spark-orange/40 bg-spark-orange/5 px-3 py-2 text-sm text-spark-orange">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        {flows.length > 0 ? (
          <SortControl
            options={AIFLOW_SORT_OPTIONS}
            field={sort.field}
            dir={sort.dir}
            onChange={setSort}
            idPrefix="aiflow-sort"
          />
        ) : (
          <span />
        )}
        <button
          onClick={() => {
            setAiWarnings([]);
            const fresh = emptyEditor();
            setEditor(fresh);
            // A pristine new flow isn't dirty until the owner types something.
            setEditorBaseline(JSON.stringify(fresh));
          }}
          className="inline-flex items-center gap-1 rounded-md bg-signal-teal px-3 py-2 text-sm font-semibold text-deep-ink hover:bg-signal-teal/90"
>
          <Plus className="h-4 w-4" /> New AiFlow
        </button>
      </div>
      {runNotice && (
        <p className="rounded-md border border-signal-teal/40 bg-signal-teal/5 px-3 py-2 text-sm text-signal-teal">
          {runNotice}
        </p>
      )}
      {flows.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">
            No AiFlows yet. Create one to automate a workflow: start it from a text, an
            email, a schedule, or run it on demand.
          </p>
        </Card>
      ) : (
        sortRows(flows, (row) => aiFlowSortValue(row, sort.field), sort.dir).map((row) => (
          <Card key={row.id} className="space-y-3">
            {/* Stacks on phones (full-width name, actions row below); the
                sm+ layout is byte-identical to the original single row. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                {/* items-start (not center): a long name wraps to a second
                    clamped line, and the pill + status times stay pinned to
                    the first line instead of floating mid-block. */}
                <div className="flex items-start gap-2">
                  <Link
                    href={`/dashboard/aiflows/${row.id}`}
                    title={row.name}
                    className="min-w-0 break-words font-semibold text-parchment line-clamp-2 hover:text-signal-teal hover:underline"
                  >
                    {row.name}
                  </Link>
                  <span
                    className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      row.enabled
                        ? "bg-claw-green/15 text-claw-green"
                        : "bg-parchment/10 text-parchment/50"
                    }`}
                  >
                    {row.enabled ? "ENABLED" : "OFF"}
                  </span>
                  {/* Status times: when the flow last fired, and how long the
                      current on/off state has held (toggle time; falls back to
                      created_at when never toggled). Client-mounted only (see
                      clockMounted) and hidden on narrow screens so the name
                      keeps room. */}
                  {clockMounted && (
                    <span className="mt-1 hidden shrink-0 whitespace-nowrap text-[10px] text-parchment/40 sm:inline">
                      last triggered {shortWhen(row.last_run_at) ?? "never"} ·{" "}
                      {row.enabled ? "on" : "off"} since{" "}
                      {shortWhen(row.enabled_changed_at ?? row.created_at)}
                    </span>
                  )}
                </div>
                <p
                  title={friendlyFlowSummary(row.definition)}
                  className="mt-1 text-xs text-parchment/50 line-clamp-2"
                >
                  {friendlyFlowSummary(row.definition)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-parchment/50 sm:shrink-0 sm:flex-nowrap">
                {/* Voice flows run on the real-time call path; the /run API rejects
                    them, so don't offer Run now (it would always error). */}
                {row.enabled && row.definition.trigger.channel !== "voice" && (
                  <button
                    onClick={() => {
                      setRunNotice(null);
                      setRunInput("");
                      setRunFor(runFor === row.id ? null : row.id);
                    }}
                    className="text-xs text-signal-teal hover:underline"
                  >
                    Run now
                  </button>
                )}
                {/* Test with a contact: works on DISABLED flows too (testing a
                    draft is the point); every side effect is simulated. */}
                {row.definition.trigger.channel !== "voice" && (
                  <button
                    onClick={() => {
                      setRunNotice(null);
                      setTestContact("");
                      setTestInput("");
                      setTestFor(testFor === row.id ? null : row.id);
                    }}
                    className="text-xs text-signal-teal hover:underline"
                  >
                    Test
                  </button>
                )}
                {/* Outbound voice flows are started on demand here — the call is
                    placed and metered by telnyx-voice-originate. */}
                {row.enabled &&
                  row.definition.trigger.channel === "voice" &&
                  row.definition.trigger.direction === "outbound" && (
                    <button
                      onClick={() => {
                        setRunNotice(null);
                        setCallTo("");
                        setCallFor(callFor === row.id ? null : row.id);
                      }}
                      className="text-xs text-signal-teal hover:underline"
                    >
                      Place call
                    </button>
                  )}
                <button onClick={() => toggleEnabled(row)} className="text-xs hover:text-parchment">
                  {row.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => {
                    setAiWarnings([]);
                    const opened = editorFromRow(row);
                    setEditor(opened);
                    // Opening a saved flow starts clean; edits make it dirty.
                    setEditorBaseline(JSON.stringify(opened));
                  }}
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4 hover:text-signal-teal" />
                </button>
                <button
                  onClick={() => duplicateFlow(row)}
                  aria-label="Duplicate AiFlow"
                  title="Duplicate AiFlow"
                  disabled={busy}
                >
                  <Copy className="h-4 w-4 hover:text-signal-teal" />
                </button>
                <button onClick={() => remove(row.id)} aria-label="Delete" disabled={busy}>
                  <Trash2 className="h-4 w-4 hover:text-spark-orange" />
                </button>
              </div>
            </div>
            {runFor === row.id && (
              <div className="flex items-center gap-2 border-t border-parchment/10 pt-3">
                <input
                  className={inputClass}
                  value={runInput}
                  onChange={(ev) => setRunInput(ev.target.value)}
                  placeholder="Optional input: paste a link or message text for {{trigger.url}} / {{trigger.windowText}}"
                />
                <button
                  onClick={() => runNow(row)}
                  disabled={busy}
                  className="shrink-0 rounded-md bg-spark-orange px-3 py-2 text-sm font-semibold text-deep-ink hover:bg-spark-orange/90 disabled:opacity-50"
                >
                  {busy ? "Starting…" : "Start run"}
                </button>
              </div>
            )}
            {testFor === row.id && (
              <div className="space-y-2 border-t border-parchment/10 pt-3">
                <div className="flex items-center gap-2">
                  <input
                    className={inputClass}
                    value={testContact}
                    onChange={(ev) => setTestContact(ev.target.value)}
                    placeholder="Contact phone to test as (E.164, e.g. +16025551234)"
                  />
                  <input
                    className={inputClass}
                    value={testInput}
                    onChange={(ev) => setTestInput(ev.target.value)}
                    placeholder="Optional sample message text"
                  />
                  <button
                    onClick={() => testRun(row)}
                    disabled={busy || !testContact.trim()}
                    className="shrink-0 rounded-md bg-signal-teal px-3 py-2 text-sm font-semibold text-deep-ink hover:bg-signal-teal/90 disabled:opacity-50"
                  >
                    {busy ? "Starting…" : "Start test"}
                  </button>
                </div>
                <p className="text-[11px] text-parchment/40">
                  A test run plays the whole flow through instantly with NOTHING actually sent
                  — texts, emails, team offers, and contact updates are recorded as &quot;what
                  would have happened&quot; on the runs page. The contact must exist on your
                  Contacts page.
                </p>
              </div>
            )}
            {callFor === row.id && (
              <div className="flex items-center gap-2 border-t border-parchment/10 pt-3">
                <input
                  className={inputClass}
                  value={callTo}
                  onChange={(ev) => setCallTo(ev.target.value)}
                  placeholder="Number to call (leave blank to use the flow's default)"
                />
                <button
                  onClick={() => placeCall(row)}
                  disabled={busy}
                  className="shrink-0 rounded-md bg-spark-orange px-3 py-2 text-sm font-semibold text-deep-ink hover:bg-spark-orange/90 disabled:opacity-50"
                >
                  {busy ? "Calling…" : "Place call"}
                </button>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

/**
 * "From" mailbox picker shared by send_email and the send_sms quiet-hours
 * fallback: "" = the business's own AI coworker mailbox, otherwise a
 * workspace_oauth_connections.id (send as the owner's connected mailbox).
 * A stored id that no longer resolves to a connection is still shown (as
 * "connected mailbox (disconnected?)") so saving doesn't silently reset it.
 */
function FromMailboxSelect({
  value,
  onChange,
  emailConns
}: {
  value: string;
  onChange: (connectionId: string | undefined) => void;
  emailConns: EmailConnectionOption[];
}) {
  return (
    <div>
      <label className={labelClass}>From</label>
      <select
        className={inputClass}
        value={value}
        onChange={(ev) => onChange(ev.target.value || undefined)}
      >
        <option value="">Your AI coworker&apos;s email</option>
        {value && !emailConns.some((c) => c.id === value) && (
          <option value={value}>connected mailbox (disconnected?)</option>
        )}
        {emailConns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-parchment/40">
        Connect another mailbox under Settings → Integrations to see it here.
      </p>
    </div>
  );
}

/** Cap mirrors the schema's `.max(10)` on each of cc/bcc. */
const MAX_CC_BCC = 10;

/**
 * A cc/bcc editor: a comma-separated text input backed by a string[] plus an
 * "Add employee" dropdown that appends a roster member's email. Stores
 * `undefined` (not []) when empty so the schema strips the optional field.
 */
function RecipientListField({
  label,
  value,
  onChange,
  employees
}: {
  label: string;
  value: string[] | undefined;
  onChange: (list: string[] | undefined) => void;
  employees: EmployeeEmailOption[];
}) {
  const current = value ?? [];
  const commit = (list: string[]) => onChange(list.length > 0 ? list.slice(0, MAX_CC_BCC) : undefined);
  const addEmployee = (email: string) => {
    if (!email || current.some((e) => e.toLowerCase() === email.toLowerCase())) return;
    commit([...current, email]);
  };
  // Roster members not already in this list, so the picker never re-adds a dupe.
  const available = employees.filter(
    (m) => !current.some((e) => e.toLowerCase() === m.email.toLowerCase())
  );
  return (
    <div>
      <label className={labelClass}>{label}</label>
      <input
        className={inputClass}
        value={current.join(", ")}
        onChange={(e) =>
          commit(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          )
        }
      />
      {available.length > 0 && (
        <select
          className={`${inputClass} mt-1`}
          value=""
          onChange={(e) => {
            addEmployee(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">Add employee…</option>
          {available.map((m) => (
            <option key={m.email} value={m.email}>
              {m.name ? `${m.name}: ${m.email}` : m.email}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function StepFields({
  step,
  index,
  patchStep,
  emailConns,
  employees,
  people,
  documents,
  agents,
  examples
}: {
  step: FlowStep;
  index: number;
  patchStep: (index: number, patch: Record<string, unknown>) => void;
  emailConns: EmailConnectionOption[];
  employees: EmployeeEmailOption[];
  /** Saved employees + contacts for the dynamic-number pickers. */
  people: PickerPerson[];
  /** Client-shareable business documents for the share_document picker. */
  documents: DocumentOption[];
  /** Saved agents for the run_agent picker. */
  agents: AgentOption[];
  examples: AiFlowExampleCopy;
}) {
  if (step.type === "extract_url") {
    return (
      <Field
        label="Save the link as"
        value={step.saveAs}
        onChange={(v) => patchStep(index, { saveAs: v })}
        help="A short name for the link so later steps can reuse it (e.g. lead_url)."
      />
    );
  }
  if (step.type === "browse_extract") {
    const fields = step.fields ?? [];
    const links = step.extractLinks ?? [];
    return (
      <div className="space-y-2">
        <Field
          label="Which saved link to open"
          value={step.urlVar}
          onChange={(v) => patchStep(index, { urlVar: v })}
          help="The name of a link an earlier step saved (e.g. lead_url)."
        />
        <label className={labelClass}>Fields to extract</label>
        {fields.map((f, fi) => (
          <div key={fi} className="flex gap-2">
            <input
              className={inputClass}
              value={f.name}
              placeholder={examples.contactVar}
              onChange={(ev) =>
                patchStep(index, {
                  fields: fields.map((x, xi) =>
                    xi === fi ? { ...x, name: ev.target.value } : x
                  )
                })
              }
            />
            <input
              className={inputClass}
              value={f.description ?? ""}
              placeholder="description (optional)"
              onChange={(ev) =>
                patchStep(index, {
                  fields: fields.map((x, xi) =>
                    xi === fi ? { ...x, description: ev.target.value } : x
                  )
                })
              }
            />
            <button
              onClick={() =>
                patchStep(index, {
                  // Drop the key entirely when the last field is removed so an
                  // empty array doesn't trip the schema's min(1)-when-present
                  // (a links-only browse_extract is valid).
                  fields: fields.length === 1 ? undefined : fields.filter((_, xi) => xi !== fi)
                })
              }
              className="text-xs text-parchment/40 hover:text-rust"
              aria-label="Remove field"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() => patchStep(index, { fields: [...fields, { name: "", description: "" }] })}
          className="text-xs text-signal-teal hover:underline"
        >
          + field
        </button>
        <label className={labelClass}>Links to capture (by button text)</label>
        {links.map((l, li) => (
          <div key={li} className="flex gap-2">
            <input
              className={inputClass}
              value={l.name}
              placeholder="claim_link"
              onChange={(ev) =>
                patchStep(index, {
                  extractLinks: links.map((x, xi) =>
                    xi === li ? { ...x, name: ev.target.value } : x
                  )
                })
              }
            />
            <input
              className={inputClass}
              value={l.matchText}
              placeholder="button text, e.g. Call me to claim referral"
              onChange={(ev) =>
                patchStep(index, {
                  extractLinks: links.map((x, xi) =>
                    xi === li ? { ...x, matchText: ev.target.value } : x
                  )
                })
              }
            />
            <button
              onClick={() =>
                patchStep(index, {
                  // Drop the key entirely when the last link is removed so an
                  // empty array doesn't trip the schema's min(1)-when-present.
                  extractLinks:
                    links.length === 1 ? undefined : links.filter((_, xi) => xi !== li)
                })
              }
              className="text-xs text-parchment/40 hover:text-rust"
              aria-label="Remove link"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() => patchStep(index, { extractLinks: [...links, { name: "", matchText: "" }] })}
          className="text-xs text-signal-teal hover:underline"
        >
          + link
        </button>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.screenshot ?? false}
            onChange={(ev) =>
              // Optional: round-trip false as undefined so it's dropped on save.
              patchStep(index, { screenshot: ev.target.checked ? true : undefined })
            }
          />
          Capture a screenshot of the page
        </label>
      </div>
    );
  }
  if (step.type === "extract_text") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-parchment/50">
          Reads these details straight from the incoming message - no link needed.
        </p>
        <label className={labelClass}>Fields to extract</label>
        {step.fields.map((f, fi) => (
          <div key={fi} className="flex gap-2">
            <input
              className={inputClass}
              value={f.name}
              placeholder={examples.contactVar}
              onChange={(ev) =>
                patchStep(index, {
                  fields: step.fields.map((x, xi) =>
                    xi === fi ? { ...x, name: ev.target.value } : x
                  )
                })
              }
            />
            <input
              className={inputClass}
              value={f.description ?? ""}
              placeholder="description (optional)"
              onChange={(ev) =>
                patchStep(index, {
                  fields: step.fields.map((x, xi) =>
                    xi === fi ? { ...x, description: ev.target.value } : x
                  )
                })
              }
            />
          </div>
        ))}
        <button
          onClick={() => patchStep(index, { fields: [...step.fields, { name: "", description: "" }] })}
          className="text-xs text-signal-teal hover:underline"
        >
          + field
        </button>
      </div>
    );
  }
  if (step.type === "email_extract") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-parchment/50">
          Reads a recent email from a connected mailbox and pulls these details out
          of it - handy as a fallback when a web page was slow or empty.
        </p>
        <Field
          label="Mailbox connection ID"
          value={step.connectionId}
          onChange={(v) => patchStep(index, { connectionId: v })}
        />
        <Field
          label="From contains (sender filter, optional)"
          value={step.fromContains ?? ""}
          onChange={(v) => patchStep(index, { fromContains: v || undefined })}
        />
        <Field
          label="Match terms (one per line; the email must contain ALL of them)"
          value={(step.matchTemplates ?? []).join("\n")}
          onChange={(v) => {
            const terms = v
              .split("\n")
              .map((t) => t.trim())
              .filter((t) => t.length > 0);
            patchStep(index, { matchTemplates: terms.length > 0 ? terms : undefined });
          }}
          textarea
        />
        <Field
          label="Look back (minutes)"
          value={String(step.lookbackMinutes ?? 60)}
          onChange={(v) => {
            const n = Number(v);
            patchStep(index, { lookbackMinutes: Number.isFinite(n) && n > 0 ? n : undefined });
          }}
        />
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.fillOnlyEmpty !== false}
            onChange={(ev) => patchStep(index, { fillOnlyEmpty: ev.target.checked })}
          />
          Only fill in details that earlier steps left empty (recommended)
        </label>
        <label className={labelClass}>Fields to extract</label>
        {step.fields.map((f, fi) => (
          <div key={fi} className="flex gap-2">
            <input
              className={inputClass}
              value={f.name}
              placeholder={examples.contactVar}
              onChange={(ev) =>
                patchStep(index, {
                  fields: step.fields.map((x, xi) =>
                    xi === fi ? { ...x, name: ev.target.value } : x
                  )
                })
              }
            />
            <input
              className={inputClass}
              value={f.description ?? ""}
              placeholder="description (optional)"
              onChange={(ev) =>
                patchStep(index, {
                  fields: step.fields.map((x, xi) =>
                    xi === fi ? { ...x, description: ev.target.value } : x
                  )
                })
              }
            />
          </div>
        ))}
        <button
          onClick={() => patchStep(index, { fields: [...step.fields, { name: "", description: "" }] })}
          className="text-xs text-signal-teal hover:underline"
        >
          + field
        </button>
      </div>
    );
  }
  if (step.type === "send_sms") {
    const qh = step.quietHours;
    return (
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={Boolean(step.replyToGroup)}
            onChange={(ev) =>
              // Group reply is its own recipient source — clear any prior
              // `to`/`toAgentName`/`toRef` so the "exactly one recipient" rule
              // passes on save (those fields are hidden while group reply is on).
              patchStep(
                index,
                ev.target.checked
                  ? { replyToGroup: true, to: undefined, toAgentName: undefined, toRef: undefined }
                  : { replyToGroup: undefined }
              )
            }
          />
          Reply into the group text (everyone on the thread except your number)
        </label>
        {!step.replyToGroup &&
          (step.toRef ? (
            // Saved-contact recipient: the person's LIVE number is resolved at
            // send time (renumbers/merges propagate automatically).
            <ContactRefPicker
              label="Recipient (saved contact: live number)"
              textValue=""
              refValue={step.toRef}
              people={people}
              onChangeText={() => patchStep(index, { toRef: undefined })}
              onChangeRef={(ref) =>
                patchStep(index, { toRef: ref, to: undefined, toAgentName: undefined })
              }
            />
          ) : (
            <>
              {/* Recipient is phone OR team-member OR saved contact, never
                  more than one. Hide the other controls once one is chosen;
                  but if BOTH text fields are somehow set (invalid imported/
                  legacy data) keep both visible so it can be corrected. */}
              {(!step.toAgentName || Boolean(step.to)) && (
                <Field
                  label="Recipient (phone or {{vars.x}})"
                  value={step.to ?? ""}
                  onChange={(v) => patchStep(index, { to: v.trim() ? v : undefined })}
                />
              )}
              {(!step.to || Boolean(step.toAgentName)) && (
                <Field
                  label="Or send to a team member by name (resolves their phone; body can use {{agent.name}})"
                  value={step.toAgentName ?? ""}
                  onChange={(v) => patchStep(index, { toAgentName: v.trim() ? v : undefined })}
                />
              )}
              {!step.to && !step.toAgentName && people.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const first = people[0];
                    patchStep(index, {
                      toRef: { source: first.source, id: first.id, label: first.name },
                      to: undefined,
                      toAgentName: undefined
                    });
                  }}
                  className="text-[11px] text-signal-teal hover:underline"
                >
                  Or pick a saved contact (live number)
                </button>
              )}
            </>
          ))}
        <Field label="Message" value={step.body} onChange={(v) => patchStep(index, { body: v })} textarea />
        <Field
          label='Attach image (variable from an earlier "Create an AI-generated image" step, optional)'
          value={step.mediaUrlVar ?? ""}
          onChange={(v) => patchStep(index, { mediaUrlVar: v.trim() ? v.trim() : undefined })}
          help="Sends the text as a picture message (MMS). If the image is missing at run time, the text still goes out on its own."
        />
        <div className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2 space-y-2">
          <label className="flex items-center gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              checked={Boolean(qh)}
              onChange={(ev) =>
                patchStep(index, {
                  quietHours: ev.target.checked
                    ? {
                        timezone: "America/Phoenix",
                        noSendAfter: "22:00",
                        resumeAt: "08:30"
                      }
                    : undefined
                })
              }
            />
            Quiet hours
          </label>
          {qh && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Field
                  label="Time zone"
                  value={qh.timezone}
                  onChange={(v) => patchStep(index, { quietHours: { ...qh, timezone: v } })}
                />
                <Field
                  label="No texts after"
                  value={qh.noSendAfter}
                  onChange={(v) => patchStep(index, { quietHours: { ...qh, noSendAfter: v } })}
                />
                <Field
                  label="Resume texting at"
                  value={qh.resumeAt}
                  onChange={(v) => patchStep(index, { quietHours: { ...qh, resumeAt: v } })}
                />
              </div>
              <Field
                label="After-hours email: variable holding the lead's email (optional; emailed right away while the text waits until morning)"
                value={qh.emailFallbackVar ?? ""}
                onChange={(v) =>
                  patchStep(index, {
                    quietHours: { ...qh, emailFallbackVar: v.trim() ? v.trim() : undefined }
                  })
                }
              />
              {qh.emailFallbackVar && (
                <>
                  <Field
                    label="Fallback email subject"
                    value={qh.emailSubject ?? ""}
                    onChange={(v) =>
                      patchStep(index, {
                        quietHours: { ...qh, emailSubject: v.trim() ? v : undefined }
                      })
                    }
                  />
                  <FromMailboxSelect
                    value={qh.emailFromConnectionId ?? ""}
                    onChange={(connectionId) =>
                      patchStep(index, {
                        quietHours: { ...qh, emailFromConnectionId: connectionId }
                      })
                    }
                    emailConns={emailConns}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (step.type === "send_email") {
    return (
      <div className="space-y-2">
        <Field
          label="Recipient email"
          value={step.to}
          onChange={(v) => patchStep(index, { to: v })}
        />
        <RecipientListField
          label="Cc (optional, comma-separated)"
          value={step.cc}
          onChange={(list) => patchStep(index, { cc: list })}
          employees={employees}
        />
        <RecipientListField
          label="Bcc (optional, comma-separated)"
          value={step.bcc}
          onChange={(list) => patchStep(index, { bcc: list })}
          employees={employees}
        />
        <FromMailboxSelect
          value={step.fromConnectionId ?? ""}
          onChange={(connectionId) => patchStep(index, { fromConnectionId: connectionId })}
          emailConns={emailConns}
        />
        <Field
          label={`Subject (e.g. ${examples.emailSubjectExample})`}
          value={step.subject}
          onChange={(v) => patchStep(index, { subject: v })}
        />
        <Field label="Body" value={step.body} onChange={(v) => patchStep(index, { body: v })} textarea />
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.attachScreenshot ?? false}
            onChange={(ev) =>
              patchStep(index, { attachScreenshot: ev.target.checked ? true : undefined })
            }
          />
          Attach the screenshot from an earlier browse step (AI coworker email only)
        </label>
      </div>
    );
  }
  if (step.type === "approval_gate") {
    return (
      <Field label="Approval prompt" value={step.prompt} onChange={(v) => patchStep(index, { prompt: v })} />
    );
  }
  if (step.type === "notify_owner") {
    return (
      <Field
        label="Owner message"
        value={step.message}
        onChange={(v) => patchStep(index, { message: v })}
        textarea
      />
    );
  }
  if (step.type === "route_to_team") {
    const ow = step.offerWindow;
    return (
      <div className="space-y-2">
        <Field
          label="Agent offer SMS (use {{agent.name}} / {{offer.deadline}}, reply 1=claim / 2=pass)"
          value={step.offerTemplate}
          onChange={(v) => patchStep(index, { offerTemplate: v })}
          textarea
        />
        <Field
          label="Minutes to respond before escalating"
          value={String(step.responseMinutes ?? 10)}
          onChange={(v) => {
            const n = Number(v);
            patchStep(index, { responseMinutes: Number.isFinite(n) && n > 0 ? Math.round(n) : 10 });
          }}
        />
        <ContactRefPicker
          label={`Pin to one team member (optional; e.g. ${examples.pinExample})`}
          placeholder={examples.pinExample}
          textValue={step.agentName ?? ""}
          refValue={step.agentRef}
          people={people}
          employeesOnly
          onChangeText={(v) => patchStep(index, { agentName: v.trim() ? v : undefined })}
          onChangeRef={(ref) => patchStep(index, { agentRef: ref, agentName: undefined })}
          help="Picked employees resolve to their current number at send time."
        />
        <Field
          label="Owner fallback SMS (when no agent claims)"
          value={step.ownerFallbackTemplate}
          onChange={(v) => patchStep(index, { ownerFallbackTemplate: v })}
          textarea
        />
        <Field
          label="Owner notice when claimed (optional)"
          value={step.claimedNotifyTemplate ?? ""}
          onChange={(v) =>
            // Optional: an empty value must round-trip as undefined, not "",
            // since the schema requires min(1) when the key is present.
            patchStep(index, { claimedNotifyTemplate: v.trim() ? v : undefined })
          }
          textarea
        />
        <div className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2 space-y-2">
          <label className="flex items-center gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              checked={Boolean(step.ownerDirectWhen)}
              onChange={(ev) =>
                // Both-or-neither (enforced on save): enabling seeds the $1M
                // example; disabling clears the pair.
                patchStep(
                  index,
                  ev.target.checked
                    ? {
                        ownerDirectWhen: { var: "price_band", equals: "over_1m" },
                        ownerDirectTemplate:
                          step.ownerDirectTemplate ??
                          "HIGH-VALUE lead kept for you — not offered to the team."
                      }
                    : { ownerDirectWhen: undefined, ownerDirectTemplate: undefined }
                )
              }
            />
            Keep the lead for the owner (no team offer) when…
          </label>
          {step.ownerDirectWhen && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className={`${inputClass} w-auto`}
                  value={step.ownerDirectWhen.var}
                  placeholder="price_band"
                  onChange={(ev) =>
                    patchStep(index, {
                      ownerDirectWhen: { ...step.ownerDirectWhen, var: ev.target.value }
                    })
                  }
                />
                <select
                  className={`${inputClass} w-auto`}
                  value={
                    step.ownerDirectWhen.notEquals !== undefined
                      ? "notEquals"
                      : step.ownerDirectWhen.contains !== undefined
                        ? "contains"
                        : "equals"
                  }
                  onChange={(ev) => {
                    const value =
                      step.ownerDirectWhen?.equals ??
                      step.ownerDirectWhen?.notEquals ??
                      step.ownerDirectWhen?.contains ??
                      "";
                    const v = step.ownerDirectWhen?.var ?? "";
                    const next =
                      ev.target.value === "notEquals"
                        ? { var: v, notEquals: value }
                        : ev.target.value === "contains"
                          ? { var: v, contains: value }
                          : { var: v, equals: value };
                    patchStep(index, { ownerDirectWhen: next });
                  }}
                >
                  <option value="equals">equals</option>
                  <option value="notEquals">does not equal</option>
                  <option value="contains">contains</option>
                </select>
                <input
                  className={`${inputClass} flex-1`}
                  value={
                    step.ownerDirectWhen.equals ??
                    step.ownerDirectWhen.notEquals ??
                    step.ownerDirectWhen.contains ??
                    ""
                  }
                  placeholder="over_1m"
                  onChange={(ev) => {
                    const w = step.ownerDirectWhen!;
                    const next =
                      w.notEquals !== undefined
                        ? { var: w.var, notEquals: ev.target.value }
                        : w.contains !== undefined
                          ? { var: w.var, contains: ev.target.value }
                          : { var: w.var, equals: ev.target.value };
                    patchStep(index, { ownerDirectWhen: next });
                  }}
                />
              </div>
              <Field
                label="Owner SMS when kept (sent instead of any team offer)"
                value={step.ownerDirectTemplate ?? ""}
                onChange={(v) => patchStep(index, { ownerDirectTemplate: v })}
                textarea
              />
              <p className="text-[11px] text-parchment/50">
                Checked once, before anyone is offered. Steps gated on a claim are
                skipped, and the outcome notification says the lead was kept.
              </p>
            </>
          )}
        </div>
        <div className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2 space-y-2">
          <label className="flex items-center gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              checked={Boolean(ow)}
              onChange={(ev) =>
                patchStep(index, {
                  offerWindow: ev.target.checked
                    ? {
                        timezone: "America/Phoenix",
                        quietStart: "21:00",
                        quietEnd: "08:30",
                        graceMinutes: 10
                      }
                    : undefined
                })
              }
            />
            After-hours offers: the claim countdown starts in the morning
          </label>
          {ow && (
            <div className="flex flex-wrap gap-2">
              <Field
                label="Time zone"
                value={ow.timezone}
                onChange={(v) => patchStep(index, { offerWindow: { ...ow, timezone: v } })}
              />
              <Field
                label="Quiet from"
                value={ow.quietStart}
                onChange={(v) => patchStep(index, { offerWindow: { ...ow, quietStart: v } })}
              />
              <Field
                label="Until"
                value={ow.quietEnd}
                onChange={(v) => patchStep(index, { offerWindow: { ...ow, quietEnd: v } })}
              />
              <Field
                label="Grace minutes"
                value={String(ow.graceMinutes ?? 10)}
                onChange={(v) => {
                  const n = Number(v);
                  patchStep(index, {
                    offerWindow: {
                      ...ow,
                      graceMinutes: Number.isFinite(n) && n >= 0 ? Math.round(n) : 10
                    }
                  });
                }}
              />
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.attachScreenshot ?? false}
            onChange={(ev) =>
              patchStep(index, { attachScreenshot: ev.target.checked ? true : undefined })
            }
          />
          Attach the screenshot from an earlier browse step to each agent offer (MMS)
        </label>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.firstToClaim !== false}
            onChange={(ev) =>
              // ON is the default, so checked round-trips as undefined and
              // only an explicit opt-out stores firstToClaim: false.
              patchStep(index, { firstToClaim: ev.target.checked ? undefined : false })
            }
          />
          First to claim: teammates offered earlier can still grab a live offer with a
          bare &quot;1&quot; (an ETA reply never preempts the active window)
        </label>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.preferContactOwner === true}
            onChange={(ev) =>
              patchStep(index, { preferContactOwner: ev.target.checked ? true : undefined })
            }
          />
          Offer the contact&apos;s owner first: when this lead already belongs to a teammate
          (they claimed them before, or you assigned them on the contact page), they get the
          offer before the normal rotation
        </label>
      </div>
    );
  }
  if (step.type === "browse_action") {
    return (
      <div className="space-y-2">
        <Field label="URL variable" value={step.urlVar} onChange={(v) => patchStep(index, { urlVar: v })} />
        <Field
          label="Login integration label (optional; for pages behind the owner's account)"
          value={step.auth?.integrationLabel ?? ""}
          onChange={(v) =>
            patchStep(index, { auth: v.trim() ? { integrationLabel: v } : undefined })
          }
        />
        <label className={labelClass}>
          Page actions, in order (use {"{{vars.actions_taken}}"} in a fill value to describe what this flow did)
        </label>
        {step.actions.map((a, ai) => (
          <div key={ai} className="flex flex-wrap items-center gap-2">
            <select
              className={`${inputClass} w-auto`}
              value={a.kind}
              onChange={(ev) =>
                patchStep(index, {
                  actions: step.actions.map((x, xi) =>
                    xi === ai ? { ...x, kind: ev.target.value as (typeof BROWSE_ACTION_KINDS)[number] } : x
                  )
                })
              }
            >
              {BROWSE_ACTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {BROWSE_ACTION_LABELS[k]}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} flex-1`}
              value={a.target}
              placeholder={
                a.kind === "select_option" || a.kind.endsWith("_selector")
                  ? "CSS selector"
                  : a.kind === "click_role"
                    ? "ARIA role (e.g. option, button)"
                    : "visible text / placeholder"
              }
              onChange={(ev) =>
                patchStep(index, {
                  actions: step.actions.map((x, xi) =>
                    xi === ai ? { ...x, target: ev.target.value } : x
                  )
                })
              }
            />
            {(a.kind.startsWith("fill") || a.kind === "click_role" || a.kind === "select_option") && (
              <input
                className={`${inputClass} flex-1`}
                value={a.valueTemplate ?? ""}
                placeholder={
                  a.kind === "click_role"
                    ? "accessible name to click"
                    : a.kind === "select_option"
                      ? "option to choose"
                      : "value to type"
                }
                onChange={(ev) =>
                  patchStep(index, {
                    actions: step.actions.map((x, xi) =>
                      xi === ai
                        ? { ...x, valueTemplate: ev.target.value ? ev.target.value : undefined }
                        : x
                    )
                  })
                }
              />
            )}
            <button
              onClick={() =>
                patchStep(index, { actions: step.actions.filter((_, xi) => xi !== ai) })
              }
              className="text-parchment/40 hover:text-spark-orange"
              aria-label="Remove action"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            patchStep(index, {
              actions: [...step.actions, { kind: "click_text", target: "" }]
            })
          }
          className="text-xs text-signal-teal hover:underline"
        >
          + action
        </button>
        <Field
          label="Repeat the actions for each list link matching this CSS selector (optional; loops over a list)"
          value={step.forEachLink ?? ""}
          onChange={(v) => patchStep(index, { forEachLink: v.trim() ? v.trim() : undefined })}
          help="Leave blank to act on a single page. When set, the actions run on every matching link; extraction fields, screenshot, and remember-link are hidden and dropped on save (they're kept in the editor so clearing the selector restores them)."
        />
        {step.forEachLink ? (
          <>
            <Field
              label="Only loop over links naming one of these (optional; variable name)"
              value={step.forEachLinkMatchVar ?? ""}
              onChange={(v) =>
                patchStep(index, { forEachLinkMatchVar: v.trim() ? v.trim() : undefined })
              }
              help="A variable from an earlier step holding a list of names (comma/newline/semicolon separated). Only list links whose text contains one of those names are acted on. Leave blank to act on every matching link."
            />
            <p className="text-xs text-parchment/50">
              Looping over each matching link, so per-page field extraction, screenshot, and
              remember-link are unavailable. Clear the selector above to re-enable them.
            </p>
          </>
        ) : (
          <>
            <label className={labelClass}>Fields to extract after the actions (optional)</label>
            {(step.fields ?? []).map((f, fi) => (
              <div key={fi} className="flex gap-2">
                <input
                  className={inputClass}
                  value={f.name}
                  placeholder={examples.contactVar}
                  onChange={(ev) =>
                    patchStep(index, {
                      fields: (step.fields ?? []).map((x, xi) =>
                        xi === fi ? { ...x, name: ev.target.value } : x
                      )
                    })
                  }
                />
                <input
                  className={inputClass}
                  value={f.description ?? ""}
                  placeholder="description (optional)"
                  onChange={(ev) =>
                    patchStep(index, {
                      fields: (step.fields ?? []).map((x, xi) =>
                        xi === fi ? { ...x, description: ev.target.value } : x
                      )
                    })
                  }
                />
                <button
                  onClick={() => {
                    const next = (step.fields ?? []).filter((_, xi) => xi !== fi);
                    patchStep(index, { fields: next.length ? next : undefined });
                  }}
                  className="text-parchment/40 hover:text-spark-orange"
                  aria-label="Remove field"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                patchStep(index, {
                  fields: [...(step.fields ?? []), { name: "", description: "" }]
                })
              }
              className="text-xs text-signal-teal hover:underline"
            >
              + field
            </button>
            <label className="flex items-center gap-2 text-xs text-parchment/70">
              <input
                type="checkbox"
                checked={step.screenshot ?? false}
                onChange={(ev) =>
                  patchStep(index, { screenshot: ev.target.checked ? true : undefined })
                }
              />
              Capture a screenshot after the actions (audit trail)
            </label>
            <Field
              label="Remember this link for later runs, keyed by this phone variable (optional)"
              value={step.rememberUrlKeyedByVar ?? ""}
              onChange={(v) =>
                patchStep(index, { rememberUrlKeyedByVar: v.trim() ? v.trim() : undefined })
              }
            />
          </>
        )}
      </div>
    );
  }
  if (step.type === "recall_url") {
    return (
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.keyFromTrigger === "participants"}
            onChange={(ev) =>
              patchStep(index, { keyFromTrigger: ev.target.checked ? "participants" : undefined })
            }
          />
          Match by the people in the incoming group text
        </label>
        <Field
          label="Or match by phone variables (comma-separated, optional)"
          value={(step.keyVars ?? []).join(", ")}
          onChange={(v) => {
            const list = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            patchStep(index, { keyVars: list.length > 0 ? list : undefined });
          }}
        />
        <Field label="Save the link as" value={step.saveAs} onChange={(v) => patchStep(index, { saveAs: v })} />
      </div>
    );
  }
  if (step.type === "upsert_customer") {
    return (
      <div className="space-y-2">
        <Field
          label="Phone variable (keys the contact)"
          value={step.phoneVar}
          onChange={(v) => patchStep(index, { phoneVar: v })}
        />
        <Field
          label="Name variable (optional)"
          value={step.nameVar ?? ""}
          onChange={(v) => patchStep(index, { nameVar: v || undefined })}
        />
        <Field
          label="Email variable (optional)"
          value={step.emailVar ?? ""}
          onChange={(v) => patchStep(index, { emailVar: v || undefined })}
        />
      </div>
    );
  }
  if (step.type === "classify") {
    return (
      <div className="space-y-2">
        <Field
          label="Message to read (variable; empty = the triggering message)"
          value={step.textVar ?? ""}
          onChange={(v) => patchStep(index, { textVar: v.trim() ? v.trim() : undefined })}
          help='Usually the reply a "Wait for their reply" step saved, e.g. reply_text.'
        />
        <Field
          label="Context for the AI (optional)"
          value={step.question ?? ""}
          onChange={(v) => patchStep(index, { question: v.trim() ? v : undefined })}
          help='e.g. "The lead was asked why they are shopping for insurance."'
        />
        <label className={labelClass}>Categories (the AI picks exactly one)</label>
        {step.categories.map((c, ci) => (
          <div key={ci} className="flex gap-2">
            <input
              className={inputClass}
              value={c.value}
              placeholder="wants_a_call"
              onChange={(ev) =>
                patchStep(index, {
                  categories: step.categories.map((x, xi) =>
                    xi === ci ? { ...x, value: ev.target.value } : x
                  )
                })
              }
            />
            <input
              className={inputClass}
              value={c.description ?? ""}
              placeholder="when to pick this (optional)"
              onChange={(ev) =>
                patchStep(index, {
                  categories: step.categories.map((x, xi) =>
                    xi === ci ? { ...x, description: ev.target.value || undefined } : x
                  )
                })
              }
            />
            <button
              onClick={() =>
                patchStep(index, { categories: step.categories.filter((_, xi) => xi !== ci) })
              }
              className="text-parchment/40 hover:text-spark-orange"
              aria-label="Remove category"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            patchStep(index, { categories: [...step.categories, { value: "" }] })
          }
          className="text-xs text-signal-teal hover:underline"
        >
          + category
        </button>
        <Field
          label="Save the answer as"
          value={step.saveAs}
          onChange={(v) => patchStep(index, { saveAs: v })}
        />
        <p className="text-[11px] text-parchment/40">
          The chosen category (or &quot;unclear&quot; when nothing fits) lands in this variable —
          add a Branch step after this one with an arm per category to take the right path.
        </p>
      </div>
    );
  }
  if (step.type === "share_document") {
    return (
      <div className="space-y-2">
        <div>
          <label className={labelClass}>Document to share</label>
          <select
            className={inputClass}
            value={step.documentId}
            onChange={(e) => {
              const doc = documents.find((d) => d.id === e.target.value);
              patchStep(index, {
                documentId: e.target.value,
                documentTitle: doc?.title
              });
            }}
          >
            <option value="">Pick a document…</option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
                {d.expired ? " (expired — extend it first)" : ""}
              </option>
            ))}
          </select>
          {documents.length === 0 && (
            <p className="mt-1 text-[11px] text-parchment/40">
              No shareable documents on file yet — upload one under Memory → Documents first.
            </p>
          )}
        </div>
        <div>
          <label className={labelClass}>Deliver by</label>
          <select
            className={inputClass}
            value={step.via ?? "sms"}
            onChange={(e) => patchStep(index, { via: e.target.value })}
          >
            <option value="sms">Text message</option>
            <option value="email">Email</option>
          </select>
        </div>
        <Field
          label={(step.via ?? "sms") === "email" ? "Email address" : "Phone number"}
          value={step.to}
          onChange={(v) => patchStep(index, { to: v })}
          help="Usually a variable an earlier step extracted, e.g. {{vars.lead_phone}} or {{trigger.from}}."
        />
        <Field
          label="Message (optional)"
          value={step.messageTemplate ?? ""}
          onChange={(v) => patchStep(index, { messageTemplate: v.trim() ? v : undefined })}
          textarea
          help="Use {{share_url}} to place the link; without it the link is added at the end."
        />
        <Field
          label="Save the link as (optional)"
          value={step.saveAs ?? ""}
          onChange={(v) => patchStep(index, { saveAs: v.trim() ? v : undefined })}
          help="A short name so later steps can reuse the link (e.g. price_sheet_url)."
        />
        <p className="text-[11px] text-parchment/40">
          Only client-facing, unexpired documents can be shared. If the document expires later,
          this step stops sending it and notifies you instead.
        </p>
      </div>
    );
  }
  if (step.type === "run_agent") {
    return (
      <div className="space-y-2">
        <div>
          <label className={labelClass}>Agent to run</label>
          <select
            className={inputClass}
            value={step.agentId}
            onChange={(e) => {
              const agent = agents.find((a) => a.id === e.target.value);
              patchStep(index, {
                agentId: e.target.value,
                agentName: agent?.name
              });
            }}
          >
            <option value="">Pick an agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.enabled ? "" : " (disabled — enable it first)"}
              </option>
            ))}
          </select>
          {agents.length === 0 && (
            <p className="mt-1 text-[11px] text-parchment/40">
              No agents saved yet — create one on the Agents page first.
            </p>
          )}
        </div>
        <Field
          label="What to run it on"
          value={step.input}
          onChange={(v) => patchStep(index, { input: v })}
          textarea
          help="The text handed to the agent — e.g. {{trigger.windowText}} (the triggering message/email) or a variable an earlier step extracted."
        />
        <Field
          label="Save the result as"
          value={step.saveAs}
          onChange={(v) => patchStep(index, { saveAs: v })}
          help="A short name so later steps can use the agent's output (e.g. agent_output)."
        />
        <p className="text-[11px] text-parchment/40">
          The agent&apos;s saved instructions transform the input text; the result lands in{" "}
          {`{{vars.${step.saveAs || "agent_output"}}}`} for a later email, text, or notification.
          Each run draws from your monthly AI budget.
        </p>
      </div>
    );
  }
  if (step.type === "generate_image") {
    return (
      <div className="space-y-2">
        <Field
          label="Describe the image to create (or the edit to apply)"
          value={step.promptTemplate}
          onChange={(v) => patchStep(index, { promptTemplate: v })}
          textarea
          help="You can reuse details earlier steps found, e.g. {{vars.listing_address}}."
        />
        <Field
          label="Start from an existing photo (optional)"
          value={step.inputImageTemplate ?? ""}
          onChange={(v) =>
            patchStep(index, { inputImageTemplate: v.trim() ? v : undefined })
          }
          help='Use {{trigger.image}} for a photo attached to the triggering text or email, or an earlier step&apos;s image variable. Leave empty to create from scratch.'
        />
        <Field
          label="Save the image link as"
          value={step.saveAs}
          onChange={(v) => patchStep(index, { saveAs: v })}
        />
        <p className="text-[11px] text-parchment/40">
          Attach the saved link to a later &quot;Send a text&quot; step (goes out as a picture
          message) or include {`{{vars.${step.saveAs || "image_url"}}}`} in an email body. Each
          image draws from your monthly AI budget.
        </p>
      </div>
    );
  }
  if (step.type === "update_contact") {
    const parseTags = (v: string): string[] | undefined => {
      const list = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return list.length > 0 ? list : undefined;
    };
    return (
      <div className="space-y-2">
        <Field
          label="Phone variable (identifies the contact)"
          value={step.phoneVar}
          onChange={(v) => patchStep(index, { phoneVar: v })}
        />
        <Field
          label="Add tags (comma-separated)"
          value={(step.addTags ?? []).join(", ")}
          onChange={(v) => patchStep(index, { addTags: parseTags(v) })}
          help='e.g. "Contacted" — tags show on the Contacts page and power its filters.'
        />
        <Field
          label="Remove tags (comma-separated)"
          value={(step.removeTags ?? []).join(", ")}
          onChange={(v) => patchStep(index, { removeTags: parseTags(v) })}
          help='e.g. "New Lead" — removals apply before additions, so one step moves a lead between statuses.'
        />
      </div>
    );
  }
  if (step.type === "sleep") {
    const sleepMode =
      step.minutes !== undefined
        ? "minutes"
        : step.untilDateTemplate !== undefined
          ? "untilDate"
          : step.relativeToTemplate !== undefined || step.offsetMinutes !== undefined
            ? "relativeTo"
            : "until";
    const setMode = (mode: string) => {
      const cleared = {
        minutes: undefined,
        untilTime: undefined,
        timezone: undefined,
        untilDateTemplate: undefined,
        relativeToTemplate: undefined,
        offsetMinutes: undefined
      };
      if (mode === "minutes") patchStep(index, { ...cleared, minutes: 300 });
      else if (mode === "until")
        patchStep(index, { ...cleared, untilTime: "08:30", timezone: browserTimezone() });
      else if (mode === "untilDate")
        patchStep(index, { ...cleared, untilDateTemplate: "{{vars.renewal_date}}" });
      else
        patchStep(index, {
          ...cleared,
          relativeToTemplate: "{{trigger.starts_at}}",
          offsetMinutes: -120
        });
    };
    return (
      <div className="space-y-2">
        <div>
          <label className={labelClass}>Wait mode</label>
          <select
            className={inputClass}
            value={sleepMode}
            onChange={(ev) => setMode(ev.target.value)}
          >
            <option value="minutes">Wait a set amount of time</option>
            <option value="until">Wait until a time of day</option>
            <option value="untilDate">Wait until a date from the flow&apos;s data</option>
            <option value="relativeTo">Wait relative to a date (before / after)</option>
          </select>
        </div>
        {sleepMode === "until" && (
          <div className="grid grid-cols-2 gap-2">
            <Field
              label="Continue at (24h HH:MM)"
              value={step.untilTime ?? ""}
              onChange={(v) => patchStep(index, { untilTime: v.trim() })}
            />
            <Field
              label="Time zone"
              value={step.timezone ?? ""}
              onChange={(v) => patchStep(index, { timezone: v.trim() })}
            />
          </div>
        )}
        {sleepMode === "minutes" && (
          <Field
            label="Minutes to wait (e.g. 300 = 5 hours; max 43200 = 30 days)"
            value={String(step.minutes ?? 300)}
            onChange={(v) => {
              const n = Number(v);
              patchStep(index, {
                minutes: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
              });
            }}
          />
        )}
        {sleepMode === "untilDate" && (
          <Field
            label="Continue on this date (a variable or ISO date)"
            value={step.untilDateTemplate ?? ""}
            onChange={(v) => patchStep(index, { untilDateTemplate: v })}
            help="e.g. {{vars.renewal_date}} — a date an earlier step extracted. An unreadable date skips the wait instead of failing."
          />
        )}
        {sleepMode === "relativeTo" && (
          <div className="grid grid-cols-2 gap-2">
            <Field
              label="Anchor date/time (variable or ISO)"
              value={step.relativeToTemplate ?? ""}
              onChange={(v) => patchStep(index, { relativeToTemplate: v })}
              help="e.g. {{trigger.starts_at}} for a calendar-triggered flow."
            />
            <Field
              label="Offset minutes (negative = before)"
              value={String(step.offsetMinutes ?? -120)}
              onChange={(v) => {
                const n = Number(v);
                patchStep(index, {
                  offsetMinutes: Number.isFinite(n) ? Math.round(n) : undefined
                });
              }}
            />
          </div>
        )}
        <p className="text-[11px] text-parchment/40">
          The workflow pauses here, then continues with the next step. Nothing is sent while
          waiting.
        </p>
      </div>
    );
  }
  if (step.type === "math") {
    const OP_LABELS: Record<(typeof MATH_OPERATIONS)[number], string> = {
      add: "Add (left + right)",
      subtract: "Subtract (left − right)",
      multiply: "Multiply (left × right)",
      divide: "Divide (left ÷ right)",
      round: "Round (left to the nearest whole number)",
      date_add_minutes: "Date + minutes (left date, right minutes)",
      date_diff_days: "Days between dates (left → right)"
    };
    return (
      <div className="space-y-2">
        <div>
          <label className={labelClass}>Operation</label>
          <select
            className={inputClass}
            value={step.operation}
            onChange={(ev) => {
              const operation = ev.target.value as (typeof MATH_OPERATIONS)[number];
              patchStep(index, {
                operation,
                ...(operation === "round" ? { right: undefined } : { right: step.right ?? "0" })
              });
            }}
          >
            {MATH_OPERATIONS.map((op) => (
              <option key={op} value={op}>
                {OP_LABELS[op]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Left value"
            value={step.left}
            onChange={(v) => patchStep(index, { left: v })}
            help="A number, a date, or a variable like {{vars.quote_amount}}."
          />
          {step.operation !== "round" && (
            <Field
              label="Right value"
              value={step.right ?? ""}
              onChange={(v) => patchStep(index, { right: v })}
            />
          )}
        </div>
        <Field
          label="Save the result as"
          value={step.saveAs}
          onChange={(v) => patchStep(index, { saveAs: v })}
        />
        <p className="text-[11px] text-parchment/40">
          Use the result in later conditions and branches (e.g. lead scoring, &quot;renewal
          within 30 days&quot;). A value that isn&apos;t a number/date saves
          &quot;not_a_number&quot; instead of failing the workflow.
        </p>
      </div>
    );
  }
  if (step.type === "wait_for_reply") {
    return (
      <div className="space-y-2">
        <Field
          label="Wait for a text back from (phone variable)"
          value={step.phoneVar}
          onChange={(v) => patchStep(index, { phoneVar: v })}
          help="A variable an earlier step produced, e.g. lead_phone."
        />
        <Field
          label="Save their reply as"
          value={step.saveAs ?? "reply_text"}
          onChange={(v) => patchStep(index, { saveAs: v.trim() ? v.trim() : undefined })}
        />
        <Field
          label="Give up after (minutes, e.g. 300 = 5 hours)"
          value={String(step.timeoutMinutes ?? 1440)}
          onChange={(v) => {
            const n = Number(v);
            patchStep(index, {
              timeoutMinutes: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
            });
          }}
        />
        <p className="text-[11px] text-parchment/40">
          While waiting, their next text is captured by this workflow (the AI&apos;s normal
          conversational reply stays quiet for that message). If they don&apos;t reply in time,
          the saved reply becomes &quot;no_reply&quot; — add a follow-up step with the condition
          &quot;{step.saveAs ?? "reply_text"} equals no_reply&quot; to send a nudge, and another
          with &quot;not equals no_reply&quot; for when they did reply.
        </p>
      </div>
    );
  }
  if (step.type === "place_ai_call") {
    const transferOn = step.transfer !== undefined;
    return (
      <div className="space-y-2">
        <Field
          label="Phone variable to call (from an earlier step)"
          value={step.toVar}
          onChange={(v) => patchStep(index, { toVar: v })}
          help='The variable holding their phone number, e.g. "lead_phone".'
        />
        <Field
          label="What the AI says (opening script)"
          value={step.personaTemplate}
          onChange={(v) => patchStep(index, { personaTemplate: v })}
          textarea
          help="How the AI opens and what the call is about. You can reuse details earlier steps found, e.g. {{vars.lead_name}}."
        />
        <ContactRefPicker
          label="Text the summary to (E.164, e.g. +16025551234)"
          placeholder="+16025551234"
          textValue={step.notifyE164 ?? ""}
          refValue={step.notifyRef}
          people={people}
          onChangeText={(v) => patchStep(index, { notifyE164: v.trim() ? v.trim() : undefined })}
          onChangeRef={(ref) => patchStep(index, { notifyRef: ref, notifyE164: undefined })}
          help="After the call, the AI texts this number a summary and transcript."
        />
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={transferOn}
            onChange={(ev) =>
              patchStep(index, {
                transfer: ev.target.checked ? { toE164: "" } : undefined
              })
            }
          />
          Live-transfer the call to a person when they say it&apos;s a good time
        </label>
        {transferOn && (
          <div className="space-y-2 rounded border border-parchment/10 p-2">
            <ContactRefPicker
              label="Transfer the call to (E.164, e.g. +16025551234)"
              placeholder="+16025551234"
              textValue={step.transfer?.toE164 ?? ""}
              refValue={step.transfer?.toRef}
              people={people}
              onChangeText={(v) =>
                patchStep(index, {
                  transfer: { ...step.transfer, toE164: v.trim() ? v.trim() : undefined }
                })
              }
              onChangeRef={(ref) =>
                patchStep(index, {
                  transfer: { ...step.transfer, toRef: ref, toE164: undefined }
                })
              }
              help="When the person confirms now is a good time, the AI connects them to this number."
            />
            <Field
              label="Heads-up text sent to them as the transfer starts (optional)"
              value={step.transfer?.preSmsTemplate ?? ""}
              onChange={(v) =>
                patchStep(index, {
                  transfer: { ...step.transfer, preSmsTemplate: v.trim() ? v : undefined }
                })
              }
              textarea
              help='e.g. "LIVE TRANSFER incoming — {{vars.lead_name}} ({{vars.lead_phone}}). Pick up!"'
            />
          </div>
        )}
        <Field
          label="Save the call outcome as"
          value={step.saveAs ?? "call_outcome"}
          onChange={(v) => patchStep(index, { saveAs: v.trim() ? v : undefined })}
          help="Later steps can branch on it: transferred / answered / no_answer / not_placed / failed."
        />
        <p className="text-[11px] text-parchment/40">
          The workflow pauses while the call happens and continues once it ends, with the
          outcome saved. Calls use your voice minutes like any other AI call.
        </p>
      </div>
    );
  }
  if (step.type === "goal") {
    const kindLabel: Record<(typeof GOAL_EVENT_KINDS)[number], string> = {
      replied: "They text back",
      appointment_booked: "An appointment is booked",
      tag_added: "A tag is added to the contact",
      claimed: "A teammate claims the lead"
    };
    return (
      <div className="space-y-2">
        <Field
          label="Goal name"
          value={step.label}
          onChange={(v) => patchStep(index, { label: v })}
          help='Shown on the canvas and in run history, e.g. "Appointment booked".'
        />
        <label className={labelClass}>Jump here the moment any of these happen</label>
        {step.events.map((ev, ei) => (
          <div key={ei} className="flex gap-2">
            <select
              className={inputClass}
              value={ev.kind}
              onChange={(e) => {
                const kind = e.target.value as (typeof GOAL_EVENT_KINDS)[number];
                patchStep(index, {
                  events: step.events.map((x, xi) =>
                    xi === ei
                      ? kind === "tag_added"
                        ? { kind, tag: x.tag ?? "" }
                        : { kind }
                      : x
                  )
                });
              }}
            >
              {GOAL_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel[k]}
                </option>
              ))}
            </select>
            {ev.kind === "tag_added" && (
              <input
                className={inputClass}
                value={ev.tag ?? ""}
                placeholder="Appointment Scheduled"
                onChange={(e) =>
                  patchStep(index, {
                    events: step.events.map((x, xi) =>
                      xi === ei ? { ...x, tag: e.target.value } : x
                    )
                  })
                }
              />
            )}
            {step.events.length > 1 && (
              <button
                onClick={() =>
                  patchStep(index, { events: step.events.filter((_, xi) => xi !== ei) })
                }
                className="text-parchment/40 hover:text-spark-orange"
                aria-label="Remove goal event"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        {step.events.length < MAX_GOAL_EVENTS && (
          <button
            onClick={() =>
              patchStep(index, { events: [...step.events, { kind: "replied" as const }] })
            }
            className="text-xs text-signal-teal hover:underline"
          >
            + milestone
          </button>
        )}
        <p className="text-[11px] text-parchment/40">
          When the milestone happens, this lead&apos;s run skips everything between where it is
          and this checkpoint — so someone who already converted stops getting follow-ups. If
          the run reaches this step normally, it just passes through.
        </p>
      </div>
    );
  }
  if (step.type === "ring_handoff") {
    return (
      <div className="space-y-2">
        <ContactRefPicker
          label="Ring this number (E.164, e.g. +16025551234)"
          placeholder="+16025551234"
          textValue={step.toE164 ?? ""}
          refValue={step.toRef}
          people={people}
          onChangeText={(v) => patchStep(index, { toE164: v.trim() ? v.trim() : undefined })}
          onChangeRef={(ref) => patchStep(index, { toRef: ref, toE164: undefined })}
        />
        <Field
          label="Ring for (seconds before moving on)"
          value={String(step.ringSeconds ?? 20)}
          onChange={(v) => {
            const n = Number(v);
            patchStep(index, {
              ringSeconds: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
            });
          }}
          help="If they don't pick up within this time, the next ring step (or AI takeover) runs."
        />
      </div>
    );
  }
  if (step.type === "voice_ai_intake") {
    const fields = step.captureFields ?? [];
    return (
      <div className="space-y-2">
        <ContactRefPicker
          label="Text the summary to (E.164, e.g. +16025551234)"
          placeholder="+16025551234"
          textValue={step.notifyE164 ?? ""}
          refValue={step.notifyRef}
          people={people}
          onChangeText={(v) => patchStep(index, { notifyE164: v.trim() ? v.trim() : undefined })}
          onChangeRef={(ref) => patchStep(index, { notifyRef: ref, notifyE164: undefined })}
          help="After the AI talks to the caller, it texts this number a summary and transcript."
        />
        <Field
          label="AI persona / instructions (optional)"
          value={step.persona ?? ""}
          onChange={(v) => patchStep(index, { persona: v.trim() ? v : undefined })}
          textarea
          help="How the AI should introduce itself and what to ask, e.g. 'Amy's assistant taking a message.'"
        />
        <label className={labelClass}>Details to capture from the caller</label>
        {fields.map((f, fi) => (
          <div key={fi} className="flex gap-2">
            <input
              className={inputClass}
              value={f}
              placeholder="e.g. name"
              onChange={(ev) =>
                patchStep(index, {
                  captureFields: fields.map((x, xi) => (xi === fi ? ev.target.value : x))
                })
              }
            />
            <button
              onClick={() => {
                const next = fields.filter((_, xi) => xi !== fi);
                patchStep(index, { captureFields: next.length ? next : undefined });
              }}
              className="text-parchment/40 hover:text-spark-orange"
              aria-label="Remove field"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          onClick={() => patchStep(index, { captureFields: [...fields, ""] })}
          className="text-xs text-signal-teal hover:underline"
        >
          + detail
        </button>
      </div>
    );
  }
  if (step.type === "voice_transfer") {
    return (
      <div className="space-y-2">
        <ContactRefPicker
          label="Connect the caller to (E.164, e.g. +16025551234)"
          placeholder="+16025551234"
          textValue={step.toE164 ?? ""}
          refValue={step.toRef}
          people={people}
          onChangeText={(v) => patchStep(index, { toE164: v.trim() ? v.trim() : undefined })}
          onChangeRef={(ref) => patchStep(index, { toRef: ref, toE164: undefined })}
        />
        <Field
          label="Say this to the caller first (optional)"
          value={step.whisper ?? ""}
          onChange={(v) => patchStep(index, { whisper: v.trim() ? v : undefined })}
          help="A short message played to the caller before they're connected, e.g. 'Connecting you now.'"
        />
      </div>
    );
  }
  if (step.type === "outbound_call") {
    const fields = step.captureFields ?? [];
    return (
      <div className="space-y-2">
        <ContactRefPicker
          label="Default number to call (E.164, e.g. +16025551234)"
          placeholder="+16025551234"
          textValue={step.toE164 ?? ""}
          refValue={step.toRef}
          people={people}
          onChangeText={(v) => patchStep(index, { toE164: v.trim() ? v.trim() : undefined })}
          onChangeRef={(ref) => patchStep(index, { toRef: ref, toE164: undefined })}
          help="Pre-fills the callee when you press Place call. You can override it for a one-off call."
        />
        <ContactRefPicker
          label="Text the summary to (E.164, e.g. +16025551234)"
          placeholder="+16025551234"
          textValue={step.notifyE164 ?? ""}
          refValue={step.notifyRef}
          people={people}
          onChangeText={(v) => patchStep(index, { notifyE164: v.trim() ? v.trim() : undefined })}
          onChangeRef={(ref) => patchStep(index, { notifyRef: ref, notifyE164: undefined })}
          help="After the AI talks to the callee, it texts this number a summary and transcript."
        />
        <Field
          label="AI persona / instructions (optional)"
          value={step.persona ?? ""}
          onChange={(v) => patchStep(index, { persona: v.trim() ? v : undefined })}
          textarea
          help="How the AI should introduce itself and what to say, e.g. 'Amy's assistant following up on your inquiry.'"
        />
        <label className={labelClass}>Details to capture from the callee</label>
        {fields.map((f, fi) => (
          <div key={fi} className="flex gap-2">
            <input
              className={inputClass}
              value={f}
              placeholder="e.g. name"
              onChange={(ev) =>
                patchStep(index, {
                  captureFields: fields.map((x, xi) => (xi === fi ? ev.target.value : x))
                })
              }
            />
            <button
              onClick={() => {
                const next = fields.filter((_, xi) => xi !== fi);
                patchStep(index, { captureFields: next.length ? next : undefined });
              }}
              className="text-parchment/40 hover:text-spark-orange"
              aria-label="Remove field"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          onClick={() => patchStep(index, { captureFields: [...fields, ""] })}
          className="text-xs text-signal-teal hover:underline"
        >
          + detail
        </button>
      </div>
    );
  }
  if (step.type === "http_call") {
    return (
      <div className="space-y-2">
        <Field label="Integration label" value={step.label} onChange={(v) => patchStep(index, { label: v })} />
        <div>
          <label className={labelClass}>Method</label>
          <select
            className={inputClass}
            value={step.method ?? "POST"}
            onChange={(ev) => patchStep(index, { method: ev.target.value })}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <Field label="Path" value={step.path ?? ""} onChange={(v) => patchStep(index, { path: v })} />
        <Field
          label="Body template"
          value={step.bodyTemplate ?? ""}
          onChange={(v) => patchStep(index, { bodyTemplate: v })}
          textarea
        />
        <Field
          label="Save response as"
          value={step.saveAs ?? ""}
          onChange={(v) => patchStep(index, { saveAs: v })}
        />
      </div>
    );
  }
  // branch: paths + nested steps are authored in the visual canvas builder;
  // the classic form shows the step header/help only.
  return (
    <p className="text-[11px] text-parchment/40">
      This step splits the workflow into paths. Edit its paths in the visual builder.
    </p>
  );
}

/** The comparison a `when` guard can use; mirrors whenSchema's mutually-exclusive keys. */
type WhenOperator = "contains" | "equals" | "notEquals";

/**
 * Optional "Only run when" guard per step. Lets the author gate a step on a var
 * an EARLIER step produced (e.g. run the buyer SMS only when lead_type contains
 * "buyer", or notify differently when phone_lead_type does not equal "none").
 * Writes `when` straight onto the step so the zod schema round-trips it; toggling
 * off clears it (undefined → dropped on JSON save).
 */
function WhenEditor({
  step,
  index,
  earlierVars,
  patchStep,
  examples
}: {
  step: FlowStep;
  index: number;
  earlierVars: string[];
  patchStep: (index: number, patch: Record<string, unknown>) => void;
  examples: AiFlowExampleCopy;
}) {
  const when = step.when;
  const operator: WhenOperator =
    when?.equals !== undefined ? "equals" : when?.notEquals !== undefined ? "notEquals" : "contains";
  const value = when?.equals ?? when?.notEquals ?? when?.contains ?? "";

  const setWhen = (next: StepCondition) => patchStep(index, { when: next });

  const buildWhen = (over: Partial<{ var: string; operator: WhenOperator; value: string }>) => {
    const v = over.var ?? when?.var ?? earlierVars[0] ?? "";
    const op = over.operator ?? operator;
    const val = over.value ?? value;
    const base: StepCondition =
      op === "equals"
        ? { var: v, equals: val }
        : op === "notEquals"
          ? { var: v, notEquals: val }
          : { var: v, contains: val };
    // Carry through a non-default caseInsensitive flag set elsewhere (e.g. AI
    // authoring or a hand-edited definition); the editor doesn't surface it, so
    // rebuilding the object would otherwise silently reset it to the default.
    if (when?.caseInsensitive !== undefined) base.caseInsensitive = when.caseInsensitive;
    return base;
  };

  return (
    <div className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2">
      <label className="flex items-center gap-2 text-xs text-parchment/70">
        <input
          type="checkbox"
          checked={Boolean(when)}
          onChange={(ev) =>
            patchStep(index, { when: ev.target.checked ? buildWhen({}) : undefined })
          }
        />
        Only run when…
      </label>
      {when && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className={`${inputClass} w-auto`}
            value={when.var}
            onChange={(ev) => setWhen(buildWhen({ var: ev.target.value }))}
          >
            {earlierVars.length === 0 && <option value="">(no earlier variables)</option>}
            {!earlierVars.includes(when.var) && when.var !== "" && (
              <option value={when.var}>{when.var}</option>
            )}
            {earlierVars.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            className={`${inputClass} w-auto`}
            value={operator}
            onChange={(ev) => setWhen(buildWhen({ operator: ev.target.value as WhenOperator }))}
          >
            <option value="contains">contains</option>
            <option value="equals">equals</option>
            <option value="notEquals">does not equal</option>
          </select>
          <input
            className={`${inputClass} flex-1`}
            value={value}
            placeholder={examples.whenValuePlaceholder}
            onChange={(ev) => setWhen(buildWhen({ value: ev.target.value }))}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Config panel for a branch step (visual builder only): the question, each
 * path's label + condition, and add/remove path controls. The steps INSIDE a
 * path are edited on the canvas itself, not here.
 */
function BranchFields({
  step,
  earlierVars,
  patch,
  examples
}: {
  step: BranchStep;
  earlierVars: string[];
  patch: (p: Record<string, unknown>) => void;
  examples: AiFlowExampleCopy;
}) {
  const setArm = (armId: string, armPatch: Partial<BranchStep["branches"][number]>) =>
    patch({
      branches: step.branches.map((a) => (a.id === armId ? { ...a, ...armPatch } : a))
    });
  return (
    <div className="space-y-2">
      <Field
        label="Question (the label shown on the canvas)"
        value={step.question}
        onChange={(v) => patch({ question: v })}
      />
      {step.branches.map((arm, ai) => (
        <div
          key={arm.id}
          className="rounded-md border border-parchment/10 bg-deep-ink/30 p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-parchment/60">Path {ai + 1}</span>
            {step.branches.length > 1 && (
              <button
                onClick={() => patch({ branches: step.branches.filter((a) => a.id !== arm.id) })}
                aria-label="Remove path"
                title={
                  arm.steps.length > 0
                    ? `Removes this path AND its ${arm.steps.length} step(s)`
                    : "Remove this path"
                }
              >
                <Trash2 className="h-4 w-4 text-parchment/40 hover:text-spark-orange" />
              </button>
            )}
          </div>
          <Field label="Label" value={arm.label} onChange={(v) => setArm(arm.id, { label: v })} />
          <ArmConditionEditor
            condition={arm.condition}
            earlierVars={earlierVars}
            examples={examples}
            onChange={(c) => setArm(arm.id, { condition: c })}
          />
          {arm.steps.length > 0 && (
            <p className="text-[11px] text-parchment/40">
              {arm.steps.length} step(s) on this path — edit them on the canvas above.
            </p>
          )}
        </div>
      ))}
      {step.branches.length < MAX_BRANCH_ARMS && (
        <button
          onClick={() =>
            patch({
              branches: [
                ...step.branches,
                {
                  id: freshStepId(),
                  label: `Path ${step.branches.length + 1}`,
                  condition: { var: earlierVars[0] ?? examples.contactVar, notEquals: "none" },
                  steps: []
                }
              ]
            })
          }
          className="inline-flex items-center gap-1 text-sm text-signal-teal hover:underline"
        >
          <Plus className="h-3 w-3" /> Add a path
        </button>
      )}
      <p className="text-[11px] text-parchment/40">
        Paths are checked top to bottom — the first match wins; no match runs the “None
        matched” path.
      </p>
    </div>
  );
}

/** A branch arm's condition (always present, unlike a step's optional `when`). */
function ArmConditionEditor({
  condition,
  earlierVars,
  onChange,
  examples
}: {
  condition: StepCondition;
  earlierVars: string[];
  onChange: (c: StepCondition) => void;
  examples: AiFlowExampleCopy;
}) {
  const operator: WhenOperator =
    condition.equals !== undefined
      ? "equals"
      : condition.notEquals !== undefined
        ? "notEquals"
        : "contains";
  const value = condition.equals ?? condition.notEquals ?? condition.contains ?? "";
  const build = (over: Partial<{ var: string; operator: WhenOperator; value: string }>) => {
    const v = over.var ?? condition.var;
    const op = over.operator ?? operator;
    const val = over.value ?? value;
    const next: StepCondition =
      op === "equals"
        ? { var: v, equals: val }
        : op === "notEquals"
          ? { var: v, notEquals: val }
          : { var: v, contains: val };
    if (condition.caseInsensitive !== undefined) next.caseInsensitive = condition.caseInsensitive;
    return next;
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={`${inputClass} w-auto`}
        value={condition.var}
        onChange={(ev) => onChange(build({ var: ev.target.value }))}
      >
        {earlierVars.length === 0 && <option value="">(no earlier variables)</option>}
        {!earlierVars.includes(condition.var) && condition.var !== "" && (
          <option value={condition.var}>{condition.var}</option>
        )}
        {earlierVars.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      <select
        className={`${inputClass} w-auto`}
        value={operator}
        onChange={(ev) => onChange(build({ operator: ev.target.value as WhenOperator }))}
      >
        <option value="contains">contains</option>
        <option value="equals">equals</option>
        <option value="notEquals">does not equal</option>
      </select>
      <input
        className={`${inputClass} flex-1`}
        value={value}
        placeholder={examples.whenValuePlaceholder}
        onChange={(ev) => onChange(build({ value: ev.target.value }))}
      />
    </div>
  );
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Flow-level business-hours window (definition.timeWindow), both editor modes. */
function TimeWindowFields({
  value,
  onChange
}: {
  value: FlowTimeWindow | null;
  onChange: (v: FlowTimeWindow | null) => void;
}) {
  return (
    <section className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-parchment/70">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(ev) =>
            onChange(
              ev.target.checked
                ? { timezone: browserTimezone(), start: "09:00", end: "17:00" }
                : null
            )
          }
        />
        Only contact people during business hours
      </label>
      {value && (
        <div className="space-y-2 rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
          <p className="text-[11px] text-parchment/40">
            Texts, emails, notifications, and team offers outside this window wait for the
            next open slot. Reading and waiting steps still run any time.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Field
              label="Opens (24h HH:MM)"
              value={value.start}
              onChange={(v) => onChange({ ...value, start: v })}
            />
            <Field
              label="Closes (24h HH:MM)"
              value={value.end}
              onChange={(v) => onChange({ ...value, end: v })}
            />
            <Field
              label="Time zone"
              value={value.timezone}
              onChange={(v) => onChange({ ...value, timezone: v })}
            />
          </div>
          <div>
            <label className={labelClass}>Days (default: every day)</label>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_LABELS.map((d, di) => (
                <label key={d} className="flex items-center gap-1 text-xs text-parchment/70">
                  <input
                    type="checkbox"
                    checked={(value.daysOfWeek ?? []).includes(di)}
                    onChange={(ev) => {
                      const days = ev.target.checked
                        ? [...(value.daysOfWeek ?? []), di].sort()
                        : (value.daysOfWeek ?? []).filter((x) => x !== di);
                      onChange({
                        ...value,
                        daysOfWeek: days.length > 0 ? days : undefined
                      });
                    }}
                  />
                  {d}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  textarea,
  help
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  help?: string;
}) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      {textarea ? (
        <textarea className={inputClass} rows={2} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {help && <p className="mt-1 text-[11px] text-parchment/40">{help}</p>}
    </div>
  );
}
