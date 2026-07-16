import type {
  AiFlowDefinition,
  FlowStep,
  FlowTrigger,
  StepCondition,
  TriggerCondition
} from "@/lib/ai-flows/schema";
import {
  BROWSE_ACTION_LABELS,
  CONDITION_LABELS,
  STEP_TYPE_LABELS
} from "@/components/dashboard/aiflow-labels";
import { SmsSegmentHint } from "@/components/dashboard/SmsSegmentHint";
import { AiFlowCanvas } from "@/components/dashboard/AiFlowCanvas";
import { formatDurationMinutes } from "@/lib/ai-flows/duration";
import type { StepStats } from "@/lib/ai-flows/tree";

/** How the workflow starts. Mirrors CHANNEL_LABELS in AiFlowsManager. */
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

/** Read-only summary of which calendar(s) a calendar trigger watches. */
const CALENDAR_SOURCE_LABELS: Record<"primary" | "shared" | "both", string> = {
  primary: "Your connected calendar",
  shared: "The shared NewCoworker calendar",
  both: "Your connected calendar + the shared NewCoworker calendar"
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const sectionClass =
  "rounded-md border border-parchment/10 bg-deep-ink/20 p-4 space-y-3";

/** One read-only "label: value" row. Multi-line values keep their whitespace. */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium text-parchment/50">{label}</div>
      <div
        className={`whitespace-pre-wrap break-words text-sm text-parchment ${
          mono ? "font-mono text-[13px]" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Display text for a voice number source: the hardcoded E.164 when set,
 * otherwise the saved-contact reference's label (the person's name captured
 * when picked — the live number is resolved at call time).
 */
function voiceTarget(e164: string | undefined, ref: { label?: string } | undefined): string {
  if (e164) return e164;
  return ref?.label ? `${ref.label} (saved contact: live number)` : "(saved contact: live number)";
}

/** A small pill used for conditions / flags. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-parchment/15 bg-deep-ink/40 px-2 py-0.5 text-[11px] text-parchment/70">
      {children}
    </span>
  );
}

function conditionLabel(c: TriggerCondition): string {
  switch (c.type) {
    case "has_url":
      return CONDITION_LABELS.has_url;
    case "contains":
      return `${CONDITION_LABELS.contains}: "${c.value}"`;
    case "regex":
      return `${CONDITION_LABELS.regex}: /${c.value}/`;
    case "from_matches":
      if (c.ref) {
        return `${CONDITION_LABELS.from_matches}: ${c.ref.label ?? "a saved contact"} (live number)`;
      }
      return `${CONDITION_LABELS.from_matches}: "${c.value}"`;
  }
}

function TriggerView({ trigger, heading = "Trigger" }: { trigger: FlowTrigger; heading?: string }) {
  return (
    <section className={sectionClass}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">{heading}</h3>
      <Row label="Starts when" value={CHANNEL_LABELS[trigger.channel]} />
      {trigger.channel === "sms" && (
        <>
          <Row
            label="Correlation window"
            value={formatDurationMinutes(trigger.correlationWindowMinutes ?? 10)}
          />
          <ConditionsView conditions={trigger.conditions} />
        </>
      )}
      {trigger.channel === "schedule" &&
        (trigger.everyMinutes !== undefined ? (
          <Row label="Runs" value={`Every ${formatDurationMinutes(trigger.everyMinutes)}`} />
        ) : (
          <>
            <Row label="Time" value={`${trigger.time} (${trigger.timezone})`} />
            <Row
              label="Days"
              value={
                trigger.daysOfWeek && trigger.daysOfWeek.length > 0
                  ? [...trigger.daysOfWeek].sort().map((d) => DAY_NAMES[d]).join(", ")
                  : "Every day"
              }
            />
          </>
        ))}
      {trigger.channel === "email" && (
        <>
          <Row label="Watched mailbox" value={trigger.connectionId} mono />
          <ConditionsView conditions={trigger.conditions} />
        </>
      )}
      {trigger.channel === "tenant_email" && (
        <>
          <Row label="Watched mailbox" value="AI coworker's dedicated mailbox" />
          <ConditionsView conditions={trigger.conditions} />
        </>
      )}
      {trigger.channel === "webhook" && (
        <>
          <Row label="Listens on" value="POST /api/public/v1/flow-events (API key)" mono />
          <ConditionsView conditions={trigger.conditions} />
        </>
      )}
      {trigger.channel === "calendar" && (
        <>
          <Row
            label="Runs"
            value={
              trigger.on === "event_start"
                ? `${formatDurationMinutes(trigger.leadMinutes ?? 0)} before an event starts`
                : trigger.on === "event_end"
                  ? (trigger.followMinutes ?? 0) > 0
                    ? `${formatDurationMinutes(trigger.followMinutes ?? 0)} after an event ends (its actual end time)`
                    : "Right when an event ends (its actual end time)"
                  : trigger.on === "event_canceled"
                    ? "When an event is canceled"
                    : "When a new event is added"
            }
          />
          <Row label="Watches" value={CALENDAR_SOURCE_LABELS[trigger.calendar ?? "both"]} />
          <ConditionsView conditions={trigger.conditions} />
        </>
      )}
      {trigger.channel === "contact_created" && (
        <ConditionsView conditions={trigger.conditions} />
      )}
      {trigger.channel === "tag_changed" && (
        <>
          <Row
            label="Fires when"
            value={`The tag ${trigger.tag ? `"${trigger.tag}" ` : "(any) "}is ${trigger.change ?? "added"}`}
          />
          <ConditionsView conditions={trigger.conditions} />
        </>
      )}
      {trigger.channel === "owner_assigned" && (
        <ConditionsView conditions={trigger.conditions} />
      )}
      {trigger.channel === "birthday" && (
        <>
          <Row
            label="Sends at"
            value={`${trigger.time ?? "09:00"}${trigger.timezone ? ` (${trigger.timezone})` : " (business timezone)"}`}
          />
          <ConditionsView conditions={trigger.conditions} />
        </>
      )}
      {trigger.channel === "voice" && trigger.direction === "outbound" && (
        <>
          <Row label="Direction" value="Outbound: you place the call" />
          {trigger.everyMinutes !== undefined ? (
            <Row label="Auto-dial" value={`Every ${formatDurationMinutes(trigger.everyMinutes)}`} />
          ) : trigger.time !== undefined && trigger.timezone !== undefined ? (
            <>
              <Row label="Auto-dial" value={`${trigger.time} (${trigger.timezone})`} />
              <Row
                label="Days"
                value={
                  trigger.daysOfWeek && trigger.daysOfWeek.length > 0
                    ? [...trigger.daysOfWeek].sort().map((d) => DAY_NAMES[d]).join(", ")
                    : "Every day"
                }
              />
            </>
          ) : (
            <Row label="Auto-dial" value="Manual (Place call button)" />
          )}
        </>
      )}
      {trigger.channel === "voice" && trigger.direction !== "outbound" && (
        <Row
          label="Caller number"
          value={voiceTarget(trigger.fromE164, trigger.fromRef)}
          mono={Boolean(trigger.fromE164)}
        />
      )}
    </section>
  );
}

function ConditionsView({ conditions }: { conditions: TriggerCondition[] }) {
  if (conditions.length === 0) {
    return <Row label="Conditions" value="Any inbound message" />;
  }
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-parchment/50">Conditions</div>
      <div className="flex flex-wrap gap-1.5">
        {conditions.map((c, i) => (
          <Chip key={i}>{conditionLabel(c)}</Chip>
        ))}
      </div>
    </div>
  );
}

/** "price_band equals \"over_1m\"" — the human reading of a StepCondition. */
function conditionText(when: StepCondition): string {
  const operator =
    when.equals !== undefined ? "equals" : when.notEquals !== undefined ? "does not equal" : "contains";
  const value = when.equals ?? when.notEquals ?? when.contains ?? "";
  return `${when.var} ${operator} "${value}"`;
}

function WhenView({ when }: { when: StepCondition }) {
  return <Row label="Only runs when" value={conditionText(when)} />;
}

/** The meaningful fields of a single step, rendered read-only. */
function StepBody({ step, coworkerEmail }: { step: FlowStep; coworkerEmail?: string }) {
  switch (step.type) {
    case "extract_url":
      return <Row label="Save URL as" value={step.saveAs} mono />;
    case "browse_extract":
      return (
        <>
          <Row label="URL variable" value={step.urlVar} mono />
          {step.fields && step.fields.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-parchment/50">Fields to extract</div>
              <div className="flex flex-wrap gap-1.5">
                {step.fields.map((f, i) => (
                  <Chip key={i}>
                    {f.name}
                    {f.description ? `: ${f.description}` : ""}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          {step.extractLinks && step.extractLinks.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-parchment/50">Links to capture</div>
              <div className="flex flex-wrap gap-1.5">
                {step.extractLinks.map((l, i) => (
                  <Chip key={i}>
                    {l.name}: “{l.matchText}”
                  </Chip>
                ))}
              </div>
            </div>
          )}
          {step.auth?.integrationLabel && (
            <Row label="Login integration" value={step.auth.integrationLabel} />
          )}
          {step.screenshot && <Chip>Captures a screenshot</Chip>}
        </>
      );
    case "extract_text":
      return (
        <div className="space-y-1">
          <div className="text-xs font-medium text-parchment/50">
            Fields read from the message text
          </div>
          <div className="flex flex-wrap gap-1.5">
            {step.fields.map((f, i) => (
              <Chip key={i}>
                {f.name}
                {f.description ? `: ${f.description}` : ""}
              </Chip>
            ))}
          </div>
        </div>
      );
    case "email_extract":
      return (
        <div className="space-y-1">
          {step.fromContains && <Row label="From contains" value={step.fromContains} />}
          {step.matchTemplates && step.matchTemplates.length > 0 && (
            <Row label="Email must contain all of" value={step.matchTemplates.join(", ")} mono />
          )}
          <Row label="Look back" value={formatDurationMinutes(step.lookbackMinutes ?? 60)} />
          <Row
            label="Fill mode"
            value={
              step.fillOnlyEmpty === true
                ? "Only fills details earlier steps left empty"
                : "Overwrites details from earlier steps"
            }
          />
          <div className="text-xs font-medium text-parchment/50">Fields read from the email</div>
          <div className="flex flex-wrap gap-1.5">
            {step.fields.map((f, i) => (
              <Chip key={i}>
                {f.name}
                {f.description ? `: ${f.description}` : ""}
              </Chip>
            ))}
          </div>
        </div>
      );
    case "doc_extract":
      return (
        <div className="space-y-1">
          <Row
            label="Document"
            value={step.sourceTemplate ?? "The triggering email's attachment"}
            mono={Boolean(step.sourceTemplate)}
          />
          {step.fileAs && (
            <Row
              label="Files into Documents as"
              value={`${step.fileAs.titleTemplate} (${step.fileAs.audience ?? "staff"})`}
            />
          )}
          <div className="text-xs font-medium text-parchment/50">
            Fields read from the document
          </div>
          <div className="flex flex-wrap gap-1.5">
            {step.fields.map((f, i) => (
              <Chip key={i}>
                {f.name}
                {f.description ? `: ${f.description}` : ""}
              </Chip>
            ))}
          </div>
        </div>
      );
    case "send_sms":
      return (
        <>
          <Row
            label="Recipient"
            value={
              step.replyToGroup
                ? "Everyone in the group text (except your number)"
                : step.toRef
                  ? `${step.toRef.label ?? "Saved contact"} (saved contact: live number)`
                  : step.toAgentName
                    ? `${step.toAgentName} (team member)`
                    : (step.to ?? "")
            }
            mono={!step.replyToGroup && !step.toAgentName && !step.toRef}
          />
          <Row label="Message" value={step.body} />
          <SmsSegmentHint text={step.body} mode="aiflow" />
          {step.mediaUrlVar && (
            <Row
              label="Attaches image (MMS)"
              value={`{{vars.${step.mediaUrlVar}}}`}
              mono
            />
          )}
          {step.quietHours && (
            <div className="rounded-md border border-parchment/10 bg-deep-ink/30 p-3 space-y-2">
              <div className="text-xs font-semibold text-parchment/60">Quiet hours</div>
              <Row
                label="Window"
                value={`No texts ${step.quietHours.noSendAfter} – ${step.quietHours.resumeAt} (${step.quietHours.timezone})`}
              />
              {step.quietHours.emailFallbackVar && (
                <Row
                  label="After-hours email"
                  value={`Emails {{vars.${step.quietHours.emailFallbackVar}}}${
                    step.quietHours.emailSubject ? `: "${step.quietHours.emailSubject}"` : ""
                  }`}
                />
              )}
            </div>
          )}
        </>
      );
    case "send_whatsapp":
      return (
        <>
          <Row
            label="Recipient"
            value={
              step.toRef
                ? `${step.toRef.label ?? "Saved contact"} (saved contact: live number)`
                : step.toAgentName
                  ? `${step.toAgentName} (team member)`
                  : (step.to ?? "")
            }
            mono={!step.toAgentName && !step.toRef}
          />
          <Row label="Message" value={step.body} />
          <Chip>
            Outside a 24-hour conversation window this goes out as an approved template
          </Chip>
        </>
      );
    case "send_email":
      return (
        <>
          <Row label="Recipient" value={step.to} mono />
          {step.cc && step.cc.length > 0 && <Row label="Cc" value={step.cc.join(", ")} mono />}
          {step.bcc && step.bcc.length > 0 && <Row label="Bcc" value={step.bcc.join(", ")} mono />}
          <Row
            label="From"
            value={
              step.fromConnectionId
                ? "Your connected mailbox (send as you)"
                : (coworkerEmail ?? "Your AI coworker's email address")
            }
            mono={!step.fromConnectionId && Boolean(coworkerEmail)}
          />
          <Row label="Subject" value={step.subject} />
          <Row label="Body" value={step.body} />
          {step.attachScreenshot && <Chip>Attaches an earlier screenshot</Chip>}
        </>
      );
    case "approval_gate":
      return <Row label="Approval prompt" value={step.prompt} />;
    case "notify_owner":
      return <Row label="Owner message" value={step.message} />;
    case "http_call":
      return (
        <>
          <Row label="Integration label" value={step.label} />
          <Row label="Method" value={step.method ?? "POST"} />
          {step.path && <Row label="Path" value={step.path} mono />}
          {step.bodyTemplate && <Row label="Body template" value={step.bodyTemplate} />}
          {step.saveAs && <Row label="Save response as" value={step.saveAs} mono />}
        </>
      );
    case "route_to_team":
      return (
        <>
          <Row label="Employee offer SMS" value={step.offerTemplate} />
          <Row label="Time to respond" value={formatDurationMinutes(step.responseMinutes ?? 10)} />
          {step.agentName && <Row label="Pinned to" value={step.agentName} />}
          {step.agentRef && (
            <Row
              label="Pinned to"
              value={`${step.agentRef.label ?? "Saved employee"} (live number)`}
            />
          )}
          <Row label="Owner fallback SMS" value={step.ownerFallbackTemplate} />
          {step.firstToClaim === false && (
            <Row
              label="First to claim"
              value="Off — only the currently offered teammate can claim a live offer"
            />
          )}
          {step.preferContactOwner === true && (
            <Row
              label="Owner-first routing"
              value="The contact's owning teammate is offered first; the normal rotation follows"
            />
          )}
          {step.claimedNotifyTemplate && (
            <Row label="Owner notice when claimed" value={step.claimedNotifyTemplate} />
          )}
          {step.ownerDirectWhen && step.ownerDirectTemplate && (
            <div className="rounded-md border border-parchment/10 bg-deep-ink/30 p-3 space-y-2">
              <div className="text-xs font-semibold text-parchment/60">
                Kept for the owner (no team offer)
              </div>
              <Row label="When" value={conditionText(step.ownerDirectWhen)} />
              <Row label="Owner SMS" value={step.ownerDirectTemplate} />
            </div>
          )}
          {step.offerWindow && (
            <div className="rounded-md border border-parchment/10 bg-deep-ink/30 p-3 space-y-2">
              <div className="text-xs font-semibold text-parchment/60">After-hours offers</div>
              <Row
                label="Window"
                value={`Quiet ${step.offerWindow.quietStart} – ${step.offerWindow.quietEnd} (${step.offerWindow.timezone}), grace ${formatDurationMinutes(step.offerWindow.graceMinutes ?? 10)}`}
              />
            </div>
          )}
          {step.attachScreenshot && <Chip>Attaches an earlier screenshot</Chip>}
        </>
      );
    case "browse_action":
      return (
        <>
          <Row label="URL variable" value={step.urlVar} mono />
          {step.auth?.integrationLabel && (
            <Row label="Login integration" value={step.auth.integrationLabel} />
          )}
          <div className="space-y-1">
            <div className="text-xs font-medium text-parchment/50">Page actions, in order</div>
            <ol className="space-y-1">
              {step.actions.map((a, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-center gap-2 text-sm text-parchment"
                >
                  <span className="text-parchment/40">{i + 1}.</span>
                  <Chip>{BROWSE_ACTION_LABELS[a.kind]}</Chip>
                  <span className="font-mono text-[13px] text-parchment/80">{a.target}</span>
                  {a.valueTemplate && (
                    <span className="text-parchment/50">→ {a.valueTemplate}</span>
                  )}
                </li>
              ))}
            </ol>
          </div>
          {step.screenshot && <Chip>Captures a screenshot</Chip>}
          {step.forEachLink && (
            <Row label="Repeats for each list link matching" value={step.forEachLink} mono />
          )}
          {step.forEachLinkMatchVar && (
            <Row
              label="Only for links named in"
              value={`{{vars.${step.forEachLinkMatchVar}}}`}
              mono
            />
          )}
          {step.rememberUrlKeyedByVar && (
            <Row label="Remembers link keyed by" value={`{{vars.${step.rememberUrlKeyedByVar}}}`} mono />
          )}
        </>
      );
    case "recall_url":
      return (
        <>
          {step.keyFromTrigger === "participants" && (
            <Chip>Matches the people in the incoming group text</Chip>
          )}
          {step.keyVars && step.keyVars.length > 0 && (
            <Row
              label="Matches phone variables"
              value={step.keyVars.map((v) => `{{vars.${v}}}`).join(", ")}
              mono
            />
          )}
          <Row label="Saves link as" value={step.saveAs} mono />
        </>
      );
    case "sleep":
      return (
        <>
          {step.minutes !== undefined ? (
            <Row label="Waits" value={formatDurationMinutes(step.minutes)} />
          ) : step.untilDateTemplate !== undefined ? (
            <Row label="Waits until" value={step.untilDateTemplate} mono />
          ) : step.relativeToTemplate !== undefined ? (
            <Row
              label="Waits"
              value={`${formatDurationMinutes(Math.abs(step.offsetMinutes ?? 0))} ${
                (step.offsetMinutes ?? 0) < 0 ? "before" : "after"
              } ${step.relativeToTemplate}`}
            />
          ) : (
            <Row label="Waits until" value={`${step.untilTime ?? "?"} (${step.timezone ?? "?"})`} />
          )}
        </>
      );
    case "wait_for_reply":
      return (
        <>
          <Row label="Waits for a text from" value={`{{vars.${step.phoneVar}}}`} mono />
          <Row label="Saves the reply as" value={step.saveAs ?? "reply_text"} mono />
          <Row
            label="Gives up after"
            value={`${formatDurationMinutes(step.timeoutMinutes ?? 1440)} (reply becomes "no_reply")`}
          />
        </>
      );
    case "math":
      return (
        <>
          <Row
            label="Calculates"
            value={`${step.operation}: ${step.left}${step.right !== undefined ? ` and ${step.right}` : ""}`}
            mono
          />
          <Row label="Saves the result as" value={step.saveAs} mono />
        </>
      );
    case "place_ai_call":
      return (
        <>
          <Row label="Calls" value={`{{vars.${step.toVar}}}`} mono />
          <Row label="AI opens with" value={step.personaTemplate} />
          {step.contextTemplate && (
            <Row label="Already knows (never re-asks)" value={step.contextTemplate} />
          )}
          <Row
            label="Texts summary to"
            value={voiceTarget(step.notifyE164, step.notifyRef)}
            mono={Boolean(step.notifyE164)}
          />
          {step.transfer && (
            <Row
              label="Live-transfers to (when it's a good time)"
              value={voiceTarget(step.transfer.toE164, step.transfer.toRef)}
              mono={Boolean(step.transfer.toE164)}
            />
          )}
          {step.transfer?.preSmsTemplate && (
            <Row label="Heads-up text before the transfer" value={step.transfer.preSmsTemplate} />
          )}
          {step.captureFields && step.captureFields.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-parchment/50">Captures from the callee</div>
              <div className="flex flex-wrap gap-1.5">
                {step.captureFields.map((f, i) => (
                  <Chip key={i}>{f}</Chip>
                ))}
              </div>
            </div>
          )}
          <Row
            label="Saves the call outcome as"
            value={`${step.saveAs ?? "call_outcome"} (transferred / answered / no_answer / not_placed / failed)`}
            mono
          />
        </>
      );
    case "goal":
      return (
        <>
          <Row label="Goal" value={step.label} />
          <div className="space-y-1">
            <div className="text-xs font-medium text-parchment/50">
              Jumps here the moment any of these happen (skipping the steps in between)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {step.events.map((ev, i) => (
                <Chip key={i}>
                  {ev.kind === "replied"
                    ? "They text back"
                    : ev.kind === "appointment_booked"
                      ? "An appointment is booked"
                      : ev.kind === "claimed"
                        ? "A teammate claims the lead"
                        : `Tag added: ${ev.tag ?? ""}`}
                </Chip>
              ))}
            </div>
          </div>
        </>
      );
    case "branch":
      return (
        <div className="space-y-2">
          <Row label="Question" value={step.question} />
          {step.branches.map((arm) => (
            <div
              key={arm.id}
              className="rounded-md border border-parchment/10 bg-deep-ink/30 p-3 space-y-2"
            >
              <div className="text-xs font-semibold text-parchment/60">
                {arm.label} — when {conditionText(arm.condition)}
              </div>
              {arm.steps.length === 0 ? (
                <div className="text-xs text-parchment/40">No steps on this path.</div>
              ) : (
                arm.steps.map((s, i) => (
                  <StepView key={s.id} step={s} index={i} coworkerEmail={coworkerEmail} />
                ))
              )}
            </div>
          ))}
          <div className="rounded-md border border-parchment/10 bg-deep-ink/30 p-3 space-y-2">
            <div className="text-xs font-semibold text-parchment/60">None matched (else)</div>
            {step.else.length === 0 ? (
              <div className="text-xs text-parchment/40">
                The workflow continues past the branch.
              </div>
            ) : (
              step.else.map((s, i) => (
                <StepView key={s.id} step={s} index={i} coworkerEmail={coworkerEmail} />
              ))
            )}
          </div>
        </div>
      );
    case "upsert_customer":
      return (
        <>
          <Row label="Phone variable" value={`{{vars.${step.phoneVar}}}`} mono />
          {step.nameVar && <Row label="Name variable" value={`{{vars.${step.nameVar}}}`} mono />}
          {step.emailVar && <Row label="Email variable" value={`{{vars.${step.emailVar}}}`} mono />}
        </>
      );
    case "classify":
      return (
        <>
          <Row
            label="Reads"
            value={step.textVar ? `{{vars.${step.textVar}}}` : "the triggering message"}
            mono
          />
          {step.question && <Row label="Context" value={step.question} />}
          <Row
            label="Categories"
            value={`${step.categories.map((c) => c.value).join(", ")} (or unclear)`}
            mono
          />
          <Row label="Saves the answer as" value={step.saveAs} mono />
        </>
      );
    case "update_contact":
      return (
        <>
          <Row label="Phone variable" value={`{{vars.${step.phoneVar}}}`} mono />
          {step.addTags && step.addTags.length > 0 && (
            <Row label="Adds tags" value={step.addTags.join(", ")} />
          )}
          {step.removeTags && step.removeTags.length > 0 && (
            <Row label="Removes tags" value={step.removeTags.join(", ")} />
          )}
        </>
      );
    case "generate_image":
      return (
        <>
          <Row label="Image description" value={step.promptTemplate} />
          {step.inputImageTemplate && (
            <Row label="Starts from photo" value={step.inputImageTemplate} mono />
          )}
          <Row label="Saves the image link as" value={step.saveAs} mono />
        </>
      );
    case "share_document":
      return (
        <>
          <Row label="Document" value={step.documentTitle ?? step.documentId} />
          <Row label={step.via === "email" ? "Email to" : "Text to"} value={step.to} mono />
          {step.messageTemplate && <Row label="Message" value={step.messageTemplate} />}
          {step.saveAs && <Row label="Saves the link as" value={step.saveAs} mono />}
        </>
      );
    case "run_agent":
      return (
        <>
          <Row label="Agent" value={step.agentName ?? step.agentId} />
          <Row label="Runs on" value={step.input} mono />
          <Row label="Saves the result as" value={step.saveAs} mono />
        </>
      );
    case "ring_handoff":
      return (
        <>
          <Row label="Ring" value={voiceTarget(step.toE164, step.toRef)} mono={Boolean(step.toE164)} />
          <Row label="Ring for" value={`${step.ringSeconds ?? 20} seconds`} />
        </>
      );
    case "voice_ai_intake":
      return (
        <>
          <Row
            label="Texts summary to"
            value={voiceTarget(step.notifyE164, step.notifyRef)}
            mono={Boolean(step.notifyE164)}
          />
          {step.persona && <Row label="AI persona" value={step.persona} />}
          {step.captureFields && step.captureFields.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-parchment/50">Captures from the caller</div>
              <div className="flex flex-wrap gap-1.5">
                {step.captureFields.map((f, i) => (
                  <Chip key={i}>{f}</Chip>
                ))}
              </div>
            </div>
          )}
        </>
      );
    case "voice_transfer":
      return (
        <>
          <Row
            label="Connect caller to"
            value={voiceTarget(step.toE164, step.toRef)}
            mono={Boolean(step.toE164)}
          />
          {step.whisper && <Row label="Says first" value={step.whisper} />}
        </>
      );
    case "outbound_call":
      return (
        <>
          {(step.toE164 || step.toRef) && (
            <Row
              label="Default number to call"
              value={voiceTarget(step.toE164, step.toRef)}
              mono={Boolean(step.toE164)}
            />
          )}
          <Row
            label="Texts summary to"
            value={voiceTarget(step.notifyE164, step.notifyRef)}
            mono={Boolean(step.notifyE164)}
          />
          {step.persona && <Row label="AI persona" value={step.persona} />}
          {step.captureFields && step.captureFields.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-parchment/50">Captures from the callee</div>
              <div className="flex flex-wrap gap-1.5">
                {step.captureFields.map((f, i) => (
                  <Chip key={i}>{f}</Chip>
                ))}
              </div>
            </div>
          )}
        </>
      );
  }
}

function StepView({
  step,
  index,
  coworkerEmail
}: {
  step: FlowStep;
  index: number;
  coworkerEmail?: string;
}) {
  return (
    <div className={sectionClass}>
      <div className="text-sm font-medium text-parchment">
        {index + 1}. {STEP_TYPE_LABELS[step.type]}
      </div>
      <StepBody step={step} coworkerEmail={coworkerEmail} />
      {step.when && <WhenView when={step.when} />}
    </div>
  );
}

/** Read-only rendering of an AiFlow definition (trigger, steps, options). */
export function AiFlowView({
  definition,
  coworkerEmail,
  statsByStepId
}: {
  definition: AiFlowDefinition;
  /** The business's AI mailbox address, shown as the sender for platform-path emails. */
  coworkerEmail?: string;
  /** Per-node run counts for the canvas overlay (flow detail page only). */
  statsByStepId?: Record<string, StepStats>;
}) {
  return (
    <div className="space-y-4">
      {/* The GHL-style flowchart view of the whole workflow; the detailed
          per-step sections below remain as the full text reference. The canvas
          heads with the PRIMARY trigger; extra (OR) triggers are listed in the
          trigger sections beneath it. */}
      <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
        <AiFlowCanvas
          trigger={definition.trigger}
          steps={definition.steps}
          readOnly
          statsByStepId={statsByStepId}
        />
      </div>
      {definition.timeWindow && (
        <p className="text-xs text-parchment/50">
          Business hours: only contacts people {definition.timeWindow.start}–
          {definition.timeWindow.end} ({definition.timeWindow.timezone}
          {definition.timeWindow.daysOfWeek && definition.timeWindow.daysOfWeek.length > 0
            ? `, ${definition.timeWindow.daysOfWeek.map((d) => DAY_NAMES[d]).join(" ")}`
            : ""}
          ); anything outside the window waits for the next open slot.
        </p>
      )}
      <TriggerView
        trigger={definition.trigger}
        heading={definition.triggers?.length ? "Trigger 1 (any one starts the flow)" : "Trigger"}
      />
      {(definition.triggers ?? []).map((t, i) => (
        <TriggerView key={i} trigger={t} heading={`Trigger ${i + 2} (or)`} />
      ))}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">Steps</h3>
        {definition.steps.map((step, i) => (
          <StepView key={step.id} step={step} index={i} coworkerEmail={coworkerEmail} />
        ))}
      </section>
      {definition.options?.suppressDefaultReply && (
        <p className="text-xs text-parchment/50">
          Suppresses the normal Coworker reply when this flow matches.
        </p>
      )}
      {definition.options?.captureStepScreenshots && (
        <p className="text-xs text-parchment/50">
          Captures a screenshot of each browser step (and a before/at-failure pair on
          failures) for the run investigate view.
        </p>
      )}
      {definition.options?.stopOnResponse && (
        <p className="text-xs text-parchment/50">
          Stops for a contact when they reply — their pending runs of this flow end
          instead of sending the remaining follow-ups.
        </p>
      )}
      {definition.options?.allowReentry === false && (
        <p className="text-xs text-parchment/50">
          Each contact goes through this flow at most once (re-entry is off).
        </p>
      )}
    </div>
  );
}
