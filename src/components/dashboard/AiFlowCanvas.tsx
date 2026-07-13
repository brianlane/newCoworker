"use client";

/**
 * AiFlowCanvas — the GHL-style vertical flowchart rendering of an AiFlow.
 *
 * Pure presentation over a definition's step TREE: a trigger node at the top,
 * color-coded step nodes joined by connectors, branch steps fanning out into
 * labeled columns (arms + the "None" else path) with dashed joins, and a
 * finish flag at the end of every terminal path — mirroring the auto-laid-out
 * tree look of GoHighLevel's workflow builder, in our dark theme, with no
 * canvas/graph dependency (nested flex columns + CSS borders).
 *
 * Two modes share this component:
 *   - EDIT (the visual builder in AiFlowsManager): "+" insert buttons between
 *     nodes open a categorized step picker; clicking a node selects it (the
 *     manager shows its config panel); hover actions move/duplicate/delete.
 *   - READ-ONLY (flow detail + library previews): interactions off; an
 *     optional per-node stats overlay shows ran/skipped/failed counts from
 *     recorded run history.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Calculator,
  Copy,
  FileText,
  Flag,
  GitBranch,
  Globe,
  HelpCircle,
  Hourglass,
  Image as ImageIcon,
  Link2,
  Mail,
  Maximize,
  MessageSquare,
  Minus,
  Phone,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Timer,
  Tag,
  Trash2,
  UserPlus,
  Users,
  Webhook,
  X,
  ZoomIn
} from "lucide-react";
import type { FlowStep, FlowTrigger, StepCondition } from "@/lib/ai-flows/schema";
import { formatDurationMinutes } from "@/lib/ai-flows/duration";
import {
  CONDITION_LABELS,
  STEP_TYPE_HELP,
  STEP_TYPE_LABELS
} from "@/components/dashboard/aiflow-labels";
import type { StepContainerRef, StepStats } from "@/lib/ai-flows/tree";

type StepType = FlowStep["type"];

/**
 * Node color category, GHL-style: waits amber, outward communication teal,
 * reads neutral, voice green, branches violet.
 */
type NodeTone = "wait" | "comm" | "read" | "voice" | "branch" | "goal";

const STEP_TONES: Record<StepType, NodeTone> = {
  extract_url: "read",
  browse_extract: "read",
  extract_text: "read",
  email_extract: "read",
  send_sms: "comm",
  send_email: "comm",
  approval_gate: "wait",
  notify_owner: "comm",
  http_call: "read",
  sleep: "wait",
  wait_for_reply: "wait",
  branch: "branch",
  goal: "goal",
  math: "read",
  route_to_team: "comm",
  browse_action: "read",
  recall_url: "read",
  upsert_customer: "read",
  update_contact: "read",
  classify: "branch",
  generate_image: "read",
  share_document: "comm",
  ring_handoff: "voice",
  voice_ai_intake: "voice",
  voice_transfer: "voice",
  outbound_call: "voice"
};

const TONE_CLASSES: Record<NodeTone, string> = {
  wait: "border-spark-orange/50 text-spark-orange",
  comm: "border-signal-teal/50 text-signal-teal",
  read: "border-parchment/25 text-parchment/70",
  voice: "border-claw-green/50 text-claw-green",
  branch: "border-purple-400/50 text-purple-300",
  goal: "border-rose-400/50 text-rose-300"
};

const STEP_ICONS: Record<StepType, ReactNode> = {
  extract_url: <Link2 className="h-4 w-4" />,
  browse_extract: <Globe className="h-4 w-4" />,
  extract_text: <Search className="h-4 w-4" />,
  email_extract: <Mail className="h-4 w-4" />,
  send_sms: <MessageSquare className="h-4 w-4" />,
  send_email: <Send className="h-4 w-4" />,
  approval_gate: <ShieldCheck className="h-4 w-4" />,
  notify_owner: <Bell className="h-4 w-4" />,
  http_call: <Webhook className="h-4 w-4" />,
  sleep: <Timer className="h-4 w-4" />,
  wait_for_reply: <Hourglass className="h-4 w-4" />,
  branch: <GitBranch className="h-4 w-4" />,
  goal: <Flag className="h-4 w-4" />,
  math: <Calculator className="h-4 w-4" />,
  route_to_team: <Users className="h-4 w-4" />,
  browse_action: <Globe className="h-4 w-4" />,
  recall_url: <Link2 className="h-4 w-4" />,
  upsert_customer: <UserPlus className="h-4 w-4" />,
  update_contact: <Tag className="h-4 w-4" />,
  classify: <HelpCircle className="h-4 w-4" />,
  generate_image: <ImageIcon className="h-4 w-4" />,
  share_document: <FileText className="h-4 w-4" />,
  ring_handoff: <Phone className="h-4 w-4" />,
  voice_ai_intake: <Phone className="h-4 w-4" />,
  voice_transfer: <Phone className="h-4 w-4" />,
  outbound_call: <Phone className="h-4 w-4" />
};

/** Short goal-event wording for node subtitles (tag_added renders its tag). */
const GOAL_EVENT_SHORT: Record<string, string> = {
  replied: "they reply",
  appointment_booked: "appointment booked",
  tag_added: "tag added",
  claimed: "teammate claims"
};

/** One-line node subtitle: the step's most identifying configured value. */
function stepSubtitle(step: FlowStep): string {
  switch (step.type) {
    case "send_sms":
      return step.replyToGroup
        ? "to the group thread"
        : step.toRef?.label
          ? `to ${step.toRef.label}`
          : step.toAgentName
            ? `to ${step.toAgentName}`
            : step.to
              ? `to ${step.to}`
              : "";
    case "send_email":
      return `to ${step.to}`;
    case "notify_owner":
      return step.message;
    case "approval_gate":
      return step.prompt;
    case "sleep":
      return step.minutes !== undefined
        ? `waits ${formatDurationMinutes(step.minutes)}`
        : step.untilDateTemplate !== undefined
          ? `until ${step.untilDateTemplate}`
          : step.relativeToTemplate !== undefined
            ? `${formatDurationMinutes(Math.abs(step.offsetMinutes ?? 0))} ${
                (step.offsetMinutes ?? 0) < 0 ? "before" : "after"
              } ${step.relativeToTemplate}`
            : `until ${step.untilTime ?? "?"} (${step.timezone ?? "?"})`;
    case "wait_for_reply":
      // The timeout IS the follow-up cadence — without it the canvas can't
      // show "nudge after 2 hours, again after 24" at a glance.
      return `from {{vars.${step.phoneVar}}} · up to ${formatDurationMinutes(step.timeoutMinutes ?? 1440)}`;
    case "branch":
      return step.question;
    case "goal":
      return `${step.label} · ${step.events
        .map((e) => (e.kind === "tag_added" ? `tag "${e.tag ?? ""}"` : GOAL_EVENT_SHORT[e.kind]))
        .join(" / ")}`;
    case "math":
      return `${step.operation}: ${step.left}${step.right !== undefined ? ` · ${step.right}` : ""} → {{vars.${step.saveAs}}}`;
    case "extract_url":
      return `saves {{vars.${step.saveAs}}}`;
    case "extract_text":
    case "email_extract":
      return step.fields.map((f) => f.name).join(", ");
    case "browse_extract":
      return [...(step.fields ?? []), ...(step.extractLinks ?? [])].map((f) => f.name).join(", ");
    case "browse_action":
      return `${step.actions.length} action(s)`;
    case "route_to_team":
      return step.agentRef?.label
        ? `pinned to ${step.agentRef.label}`
        : step.agentName
          ? `pinned to ${step.agentName}`
          : "offers the roster in turn";
    case "http_call":
      return step.label;
    case "recall_url":
      return `saves {{vars.${step.saveAs}}}`;
    case "upsert_customer":
      return `phone {{vars.${step.phoneVar}}}`;
    case "update_contact":
      return [
        ...(step.addTags ?? []).map((t) => `+${t}`),
        ...(step.removeTags ?? []).map((t) => `-${t}`)
      ].join(" ");
    case "classify":
      return `${step.textVar ? `{{vars.${step.textVar}}}` : "the message"} → ${step.categories
        .map((c) => c.value)
        .join(" / ")}`;
    case "generate_image":
      return `saves {{vars.${step.saveAs}}}`;
    case "share_document":
      return `${step.documentTitle ?? "document"} → ${step.to}`;
    case "ring_handoff":
    case "voice_transfer":
      return step.toRef?.label ?? step.toE164 ?? "";
    case "voice_ai_intake":
      return "AI captures the lead";
    case "outbound_call":
      return step.toRef?.label ?? step.toE164 ?? "AI places the call";
  }
}

/** "lead_type equals \"buyer\"" — the short reading of a when/arm condition. */
export function canvasConditionText(when: StepCondition): string {
  const op =
    when.equals !== undefined ? "=" : when.notEquals !== undefined ? "≠" : "contains";
  const value = when.equals ?? when.notEquals ?? when.contains ?? "";
  return `${when.var} ${op} “${value}”`;
}

function triggerHeadline(trigger: FlowTrigger): string {
  switch (trigger.channel) {
    case "sms":
      return "Inbound text (SMS)";
    case "manual":
      return "Run on demand";
    case "schedule":
      return trigger.everyMinutes !== undefined
        ? `Every ${formatDurationMinutes(trigger.everyMinutes)}`
        : `Daily at ${trigger.time}`;
    case "email":
      return "Inbound email (connected inbox)";
    case "tenant_email":
      return "Email to the AI coworker's mailbox";
    case "webhook":
      return "Webhook event";
    case "calendar":
      return trigger.on === "event_start"
        ? `${formatDurationMinutes(trigger.leadMinutes ?? 0)} before a calendar event`
        : trigger.on === "event_end"
          ? (trigger.followMinutes ?? 0) > 0
            ? `${formatDurationMinutes(trigger.followMinutes ?? 0)} after a calendar event ends`
            : "When a calendar event ends"
          : trigger.on === "event_canceled"
            ? "Calendar event canceled"
            : "Calendar event created";
    case "contact_created":
      return "Contact created";
    case "tag_changed":
      return `Tag ${trigger.tag ? `"${trigger.tag}" ` : ""}${trigger.change ?? "added"}`;
    case "owner_assigned":
      return "Contact assigned an owner";
    case "birthday":
      return `Contact's birthday (at ${trigger.time ?? "09:00"})`;
    case "voice":
      return trigger.direction === "outbound" ? "Outbound call (AI talks)" : "Inbound call";
  }
}

type CanvasCallbacks = {
  /** Select a step node (the manager opens its config panel). */
  onSelectStep?: (id: string) => void;
  /** Select the trigger node. */
  onSelectTrigger?: () => void;
  /** Insert a new step of `type` into `container` at `index`. */
  onInsertStep?: (container: StepContainerRef, index: number, type: StepType) => void;
  onMoveStep?: (id: string, dir: -1 | 1) => void;
  onDuplicateStep?: (id: string) => void;
  onRemoveStep?: (id: string) => void;
};

export type AiFlowCanvasProps = CanvasCallbacks & {
  trigger: FlowTrigger;
  steps: FlowStep[];
  readOnly?: boolean;
  /** Currently-selected node id ("" or undefined = none; "trigger" = trigger). */
  selectedId?: string;
  /** Step types the insert picker offers (voice flows differ from batch flows). */
  addableTypes?: readonly StepType[];
  /** Read-only stats overlay, keyed by step id (see statsByStepIdFromRunSteps). */
  statsByStepId?: Record<string, StepStats>;
};

/** Vertical connector segment between nodes. */
function Connector({ dashed }: { dashed?: boolean }) {
  return (
    <div
      className={`mx-auto h-4 w-0 border-l ${
        dashed ? "border-dashed border-parchment/30" : "border-parchment/20"
      }`}
    />
  );
}

/** Width of the fixed step-picker panel (px); matches Tailwind w-[26rem]. */
const PICKER_WIDTH = 416;
/** Min gap between the picker panel and the window edges (px). */
const PICKER_MARGIN = 8;

/**
 * The step picker, rendered through a PORTAL as a fixed overlay anchored to
 * the "+" that opened it. It deliberately lives OUTSIDE the canvas: inside,
 * it would inherit the canvas zoom (unreadably small at 50%, gigantic at
 * 200%) and get clipped by the viewport's overflow, so the full list of step
 * types was never visible at once. Fixed positioning + its own max-height
 * keeps every option on screen at any canvas zoom; it opens upward from a
 * "+" in the lower half of the window so it never runs off the bottom.
 */
function StepPickerOverlay({
  anchor,
  addableTypes,
  onPick,
  onClose
}: {
  anchor: { x: number; y: number };
  addableTypes: readonly StepType[];
  onPick: (type: StepType) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(
    Math.max(PICKER_MARGIN, anchor.x - PICKER_WIDTH / 2),
    Math.max(PICKER_MARGIN, vw - PICKER_WIDTH - PICKER_MARGIN)
  );
  // Open toward the roomier side, and cap the panel's height to the space
  // that side actually has (minus margins) so it can never run past the
  // window edge — it scrolls internally instead.
  const openUp = anchor.y > vh / 2;
  const available = openUp ? anchor.y - PICKER_MARGIN * 2 : vh - anchor.y - PICKER_MARGIN * 2;
  const maxHeight = Math.max(120, Math.min(vh * 0.7, available));
  const position: CSSProperties = openUp
    ? { left, bottom: Math.max(PICKER_MARGIN, vh - anchor.y + PICKER_MARGIN), maxHeight }
    : { left, top: anchor.y + PICKER_MARGIN, maxHeight };

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="menu"
        aria-label="Choose a step to add"
        style={position}
        className="fixed z-50 w-[26rem] max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-parchment/15 bg-deep-ink p-2 shadow-xl"
      >
        <div className="flex flex-wrap gap-1.5">
          {addableTypes.map((t) => (
            <button
              key={t}
              title={STEP_TYPE_HELP[t]}
              onClick={() => onPick(t)}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-parchment/5 ${TONE_CLASSES[STEP_TONES[t]]}`}
            >
              {STEP_ICONS[t]} {STEP_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body
  );
}

/**
 * The "+" between nodes. In edit mode it opens the fixed step-picker overlay
 * (anchored to this button's on-screen position); read-only renders a plain
 * connector dot.
 */
function InsertPoint({
  container,
  index,
  addableTypes,
  onInsertStep,
  readOnly
}: {
  container: StepContainerRef;
  index: number;
  addableTypes: readonly StepType[];
  onInsertStep?: (container: StepContainerRef, index: number, type: StepType) => void;
  readOnly?: boolean;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const open = anchor !== null;
  if (readOnly || !onInsertStep) {
    return <Connector />;
  }
  // Goal checkpoints are trunk-only (a milestone jump can never land on an
  // unevaluated branch path), so insert points inside an arm/else don't
  // offer them — mirrors the validateDefinitionSemantics rule.
  const offeredTypes =
    container.kind === "trunk" ? addableTypes : addableTypes.filter((t) => t !== "goal");
  return (
    <div className="flex flex-col items-center">
      <Connector />
      <button
        ref={buttonRef}
        onClick={() => {
          if (open) {
            setAnchor(null);
            return;
          }
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setAnchor({ x: rect.left + rect.width / 2, y: rect.bottom });
        }}
        aria-label="Add a step here"
        className={`flex h-5 w-5 items-center justify-center rounded-full border text-parchment/50 transition-colors hover:border-signal-teal hover:text-signal-teal ${
          open ? "border-signal-teal text-signal-teal" : "border-parchment/25"
        }`}
      >
        {open ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
      </button>
      {anchor && (
        <StepPickerOverlay
          anchor={anchor}
          addableTypes={offeredTypes}
          onPick={(t) => {
            setAnchor(null);
            onInsertStep(container, index, t);
          }}
          onClose={() => setAnchor(null)}
        />
      )}
      <Connector />
    </div>
  );
}

function StatsBadge({ stats }: { stats: StepStats }) {
  const parts: string[] = [];
  if (stats.done > 0) parts.push(`ran ${stats.done}×`);
  if (stats.skipped > 0) parts.push(`skipped ${stats.skipped}×`);
  if (stats.failed > 0) parts.push(`failed ${stats.failed}×`);
  if (parts.length === 0) return null;
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
        stats.failed > 0 ? "bg-red-400/15 text-red-400" : "bg-parchment/10 text-parchment/50"
      }`}
    >
      {parts.join(" · ")}
    </span>
  );
}

function NodeCard({
  step,
  selected,
  stats,
  readOnly,
  onSelectStep,
  onMoveStep,
  onDuplicateStep,
  onRemoveStep
}: {
  step: FlowStep;
  selected: boolean;
  stats?: StepStats;
  readOnly?: boolean;
} & Pick<CanvasCallbacks, "onSelectStep" | "onMoveStep" | "onDuplicateStep" | "onRemoveStep">) {
  const tone = TONE_CLASSES[STEP_TONES[step.type]];
  const subtitle = stepSubtitle(step);
  return (
    <div
      data-step-id={step.id}
      role={readOnly ? undefined : "button"}
      tabIndex={readOnly ? undefined : 0}
      onClick={readOnly ? undefined : () => onSelectStep?.(step.id)}
      onKeyDown={
        readOnly
          ? undefined
          : (ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelectStep?.(step.id);
              }
            }
      }
      className={`group relative mx-auto w-64 rounded-lg border bg-deep-ink/60 px-3 py-2 text-left transition-colors ${tone} ${
        selected ? "ring-2 ring-signal-teal" : ""
      } ${readOnly ? "" : "cursor-pointer hover:bg-deep-ink/90"}`}
    >
      <div className="flex items-center gap-2">
        {STEP_ICONS[step.type]}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-parchment">
          {STEP_TYPE_LABELS[step.type]}
        </span>
        {stats && <StatsBadge stats={stats} />}
      </div>
      {subtitle && (
        <p className="mt-0.5 truncate text-[11px] text-parchment/50">{subtitle}</p>
      )}
      {step.when && (
        <p className="mt-1 inline-block rounded-full bg-parchment/8 px-2 py-0.5 text-[10px] text-parchment/50">
          only if {canvasConditionText(step.when)}
        </p>
      )}
      {!readOnly && (
        // Hover reveals on desktop; coarse pointers (touch) have no hover, so
        // there the toolbar shows on the SELECTED step only (tapping a card
        // selects it) — lifted above the card so it never covers the step
        // title — with padded tap targets.
        <div
          className={`absolute -right-2 -top-2 hidden items-center gap-1 rounded-md border border-parchment/15 bg-deep-ink px-1 py-0.5 group-hover:flex ${
            selected ? "pointer-coarse:-top-8 pointer-coarse:flex" : ""
          }`}
        >
          <button
            onClick={(ev) => {
              ev.stopPropagation();
              onMoveStep?.(step.id, -1);
            }}
            aria-label="Move up"
            className="pointer-coarse:p-1"
          >
            <ArrowUp className="h-3.5 w-3.5 text-parchment/50 hover:text-parchment" />
          </button>
          <button
            onClick={(ev) => {
              ev.stopPropagation();
              onMoveStep?.(step.id, 1);
            }}
            aria-label="Move down"
            className="pointer-coarse:p-1"
          >
            <ArrowDown className="h-3.5 w-3.5 text-parchment/50 hover:text-parchment" />
          </button>
          <button
            onClick={(ev) => {
              ev.stopPropagation();
              onDuplicateStep?.(step.id);
            }}
            aria-label="Duplicate step"
            className="pointer-coarse:p-1"
          >
            <Copy className="h-3.5 w-3.5 text-parchment/50 hover:text-signal-teal" />
          </button>
          <button
            onClick={(ev) => {
              ev.stopPropagation();
              onRemoveStep?.(step.id);
            }}
            aria-label="Remove step"
            className="pointer-coarse:p-1"
          >
            <Trash2 className="h-3.5 w-3.5 text-parchment/50 hover:text-spark-orange" />
          </button>
        </div>
      )}
    </div>
  );
}

function FinishFlag() {
  return (
    <div className="flex flex-col items-center">
      <Connector />
      <Flag className="h-4 w-4 text-parchment/40" aria-label="End of this path" />
    </div>
  );
}

/**
 * One vertical chain of steps. `terminal` chains end with a finish flag —
 * a branch's columns are terminal only when nothing runs after the branch.
 */
function StepChain({
  steps,
  container,
  terminal,
  props
}: {
  steps: FlowStep[];
  container: StepContainerRef;
  terminal: boolean;
  props: AiFlowCanvasProps;
}) {
  const addable = props.addableTypes ?? [];
  // When a terminal chain ENDS on a branch, every path already finished inside
  // the fan (each column carries its own flag), so the chain itself renders no
  // trailing flag.
  const endsOnBranch = steps.length > 0 && steps[steps.length - 1].type === "branch";
  return (
    <div className="flex flex-col items-center">
      {steps.map((step, i) => (
        <div key={step.id} className="flex w-full flex-col items-center">
          <InsertPoint
            container={container}
            index={i}
            addableTypes={addable}
            onInsertStep={props.onInsertStep}
            readOnly={props.readOnly}
          />
          <NodeCard
            step={step}
            selected={props.selectedId === step.id}
            stats={props.statsByStepId?.[step.id]}
            readOnly={props.readOnly}
            onSelectStep={props.onSelectStep}
            onMoveStep={props.onMoveStep}
            onDuplicateStep={props.onDuplicateStep}
            onRemoveStep={props.onRemoveStep}
          />
          {step.type === "branch" && (
            <BranchFan
              step={step}
              terminal={terminal && i === steps.length - 1}
              props={props}
            />
          )}
        </div>
      ))}
      {/* Appending after a terminal branch is still allowed (the fan's columns
          then rejoin the new trunk step), so the insert point always renders in
          edit mode; only the flag moves into the fan's columns. */}
      {!(props.readOnly && terminal && endsOnBranch) && (
        <InsertPoint
          container={container}
          index={steps.length}
          addableTypes={addable}
          onInsertStep={props.onInsertStep}
          readOnly={props.readOnly}
        />
      )}
      {terminal && !endsOnBranch && (
        <Flag className="h-4 w-4 text-parchment/40" aria-label="Finish" />
      )}
    </div>
  );
}

/** The fan-out under a branch node: one labeled column per arm + "None". */
function BranchFan({
  step,
  terminal,
  props
}: {
  step: Extract<FlowStep, { type: "branch" }>;
  terminal: boolean;
  props: AiFlowCanvasProps;
}) {
  const columns: Array<{
    key: string;
    pill: string;
    pillTitle?: string;
    container: StepContainerRef;
    steps: FlowStep[];
  }> = [
    ...step.branches.map((arm) => ({
      key: arm.id,
      pill: arm.label,
      pillTitle: canvasConditionText(arm.condition),
      container: { kind: "arm", branchId: step.id, armId: arm.id } as StepContainerRef,
      steps: arm.steps
    })),
    {
      key: "__else",
      pill: "None matched",
      container: { kind: "else", branchId: step.id } as StepContainerRef,
      steps: step.else
    }
  ];
  return (
    <div className="flex w-full flex-col items-center">
      <Connector dashed />
      <div className="flex w-full items-start justify-center gap-6 border-t border-dashed border-parchment/20 pt-3">
        {columns.map((col) => (
          <div key={col.key} className="flex min-w-40 flex-1 flex-col items-center">
            <span
              title={col.pillTitle}
              className={`rounded-full px-3 py-1 text-[10px] font-semibold ${
                col.key === "__else"
                  ? "bg-parchment/10 text-parchment/60"
                  : "bg-signal-teal/15 text-signal-teal"
              }`}
            >
              {col.pill}
            </span>
            <StepChain
              steps={col.steps}
              container={col.container}
              terminal={terminal}
              props={props}
            />
          </div>
        ))}
      </div>
      {/* Paths rejoin the trunk when steps follow the branch. */}
      {!terminal && <div className="w-full border-b border-dashed border-parchment/20 pb-3" />}
    </div>
  );
}

/** The trigger node + its condition chips at the head of the canvas. */
function TriggerNode({
  trigger,
  selected,
  readOnly,
  onSelectTrigger
}: {
  trigger: FlowTrigger;
  selected: boolean;
  readOnly?: boolean;
  onSelectTrigger?: () => void;
}) {
  const conditions =
    "conditions" in trigger ? (trigger.conditions ?? []) : [];
  return (
    <div
      data-flow-node="trigger"
      role={readOnly ? undefined : "button"}
      tabIndex={readOnly ? undefined : 0}
      onClick={readOnly ? undefined : onSelectTrigger}
      onKeyDown={
        readOnly
          ? undefined
          : (ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelectTrigger?.();
              }
            }
      }
      className={`mx-auto w-64 rounded-lg border border-signal-teal/60 bg-signal-teal/10 px-3 py-2 text-left ${
        selected ? "ring-2 ring-signal-teal" : ""
      } ${readOnly ? "" : "cursor-pointer hover:bg-signal-teal/15"}`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-signal-teal/80">
        Starts when
      </div>
      <div className="text-xs font-semibold text-parchment">{triggerHeadline(trigger)}</div>
      {conditions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {conditions.map((c, i) => (
            <span
              key={i}
              className="rounded-full bg-parchment/8 px-2 py-0.5 text-[10px] text-parchment/50"
            >
              {CONDITION_LABELS[c.type]}
              {"value" in c && c.value ? `: ${c.value}` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
/** Multiplicative step for the +/- buttons. */
const ZOOM_BUTTON_FACTOR = 1.2;
/** Multiplicative step per wheel tick (ctrl/cmd + scroll, or trackpad pinch). */
const ZOOM_WHEEL_FACTOR = 1.1;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

export function AiFlowCanvas(props: AiFlowCanvasProps) {
  // Mural-style navigation: ctrl/cmd + scroll (or a trackpad pinch, which
  // browsers deliver as a ctrlKey wheel event) zooms, plain scrolling and
  // background drag pan. Zoom uses the CSS `zoom` property so the scrollable
  // area tracks the scaled layout (a transform would leave stale scrollbars).
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  const zoomBy = (factor: number) =>
    setZoom((z) => clampZoom(Math.round(z * factor * 100) / 100));

  const fitToWidth = () => {
    const el = viewportRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const contentWidth = content.getBoundingClientRect().width;
    if (contentWidth <= 0) return;
    setZoom((z) => clampZoom(Math.floor(z * ((el.clientWidth - 24) / contentWidth) * 100) / 100));
  };

  // React's onWheel is passive (preventDefault is ignored), so the zoom
  // handler attaches natively. Without preventDefault a ctrl+scroll would
  // zoom the whole page.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return; // plain scroll keeps panning
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR;
      setZoom((z) => clampZoom(Math.round(z * factor * 1000) / 1000));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Background drag pans the viewport. Window-level listeners while panning so
  // a drag that leaves the canvas keeps tracking until mouseup.
  useEffect(() => {
    if (!panning) return;
    const onMove = (ev: MouseEvent) => {
      const el = viewportRef.current;
      if (!el) return;
      el.scrollLeft = panStart.current.scrollLeft - (ev.clientX - panStart.current.x);
      el.scrollTop = panStart.current.scrollTop - (ev.clientY - panStart.current.y);
    };
    const onUp = () => setPanning(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [panning]);

  // Start the view on the FIRST item (the trigger node), not the top-left
  // corner: when a branch fan makes the flow wider than the viewport, the
  // centered trunk sits well right of scrollLeft 0 and the user would land on
  // empty canvas. Centering on the trigger's actual position (rather than
  // scrollWidth / 2) handles asymmetric fans. useLayoutEffect so the
  // correction lands before paint; mount-only so it never fights the user's
  // panning/zooming or the selection scrollIntoView effect below.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const trigger = el?.querySelector('[data-flow-node="trigger"]');
    if (!el || !trigger) return;
    const viewportRect = el.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    el.scrollLeft +=
      triggerRect.left + triggerRect.width / 2 - (viewportRect.left + viewportRect.width / 2);
    el.scrollTop = 0;
  }, []);

  // Bring a node into view when it BECOMES selected. The manager selects a
  // step the moment it is inserted, so a "+"-added step that lands below the
  // viewport's fold scrolls into view instead of silently not fitting.
  // Deliberately keyed on the selection only: config edits re-render steps on
  // every keystroke and must not yank the scroll position around.
  useEffect(() => {
    if (!props.selectedId || props.selectedId === "trigger") return;
    const node = viewportRef.current?.querySelector(
      `[data-step-id="${CSS.escape(props.selectedId)}"]`
    );
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.selectedId]);

  const startPan = (ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    // Nodes, insert points, and controls keep their own click behavior — only
    // a drag that starts on empty canvas pans.
    if ((ev.target as HTMLElement).closest('button, input, select, textarea, a, [role="button"]')) {
      return;
    }
    const el = viewportRef.current;
    if (!el) return;
    panStart.current = {
      x: ev.clientX,
      y: ev.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop
    };
    setPanning(true);
  };

  return (
    <div className="relative">
      <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-md border border-parchment/15 bg-deep-ink/90 px-1 py-0.5 text-parchment/60">
        <button
          onClick={() => zoomBy(1 / ZOOM_BUTTON_FACTOR)}
          aria-label="Zoom out"
          title="Zoom out (ctrl/cmd + scroll)"
          className="p-1 hover:text-parchment"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setZoom(1)}
          title="Reset to 100%"
          className="w-10 text-center text-[10px] font-semibold tabular-nums hover:text-parchment"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => zoomBy(ZOOM_BUTTON_FACTOR)}
          aria-label="Zoom in"
          title="Zoom in (ctrl/cmd + scroll)"
          className="p-1 hover:text-parchment"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={fitToWidth}
          aria-label="Fit to width"
          title="Fit to width"
          className="p-1 hover:text-parchment"
        >
          <Maximize className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        ref={viewportRef}
        onMouseDown={startPan}
        className={`max-h-[75vh] overflow-auto py-2 ${
          panning ? "cursor-grabbing select-none" : "cursor-grab"
        }`}
      >
        <div
          ref={contentRef}
          className="mx-auto flex min-w-fit flex-col items-center"
          style={{ zoom } as CSSProperties}
        >
          <TriggerNode
            trigger={props.trigger}
            selected={props.selectedId === "trigger"}
            readOnly={props.readOnly}
            onSelectTrigger={props.onSelectTrigger}
          />
          <StepChain
            steps={props.steps}
            container={{ kind: "trunk" }}
            terminal
            props={props}
          />
        </div>
      </div>
    </div>
  );
}
