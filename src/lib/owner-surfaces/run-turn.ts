/**
 * One owner-operator turn, for every surface that runs one.
 *
 * The registry says what a surface IS, turn-surfaces says how to CONFIGURE
 * one, and this runs it. Until now each surface assembled the run itself,
 * in the same order, from the same parts:
 *
 *   - owner-sms-turn/route.ts  (SMS)
 *   - slack/worker.ts          (Slack)
 *   - messenger/staff-turn.ts  (WhatsApp)
 *
 * Three copies that agreed only because someone kept them in step by hand.
 * They already shared `gates.ts` and `system.ts`; what they did not share is
 * the ORDER and the failure taxonomy, which is where the interesting bugs
 * live. This is that order, written once.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It has no transport: it neither reads
 * the inbound message nor sends the reply. A caller hands it a transcript
 * and gets back a verdict. That keeps every channel-specific concern (Slack
 * streaming and thread status, WhatsApp's psid trust rule, the SMS worker's
 * abort budget) in the channel, and keeps this testable without a network.
 *
 * THE FAILURE TAXONOMY IS THE POINT, so read the outcome union before
 * changing anything. `silent` and `over_cap` are NOT failures: they are
 * decisions the caller has to voice differently (Slack posts a line, SMS and
 * WhatsApp say nothing). Collapsing them into `failed` is how a surface ends
 * up retrying a terminal condition three times and then dead-lettering the
 * job under a code that describes the wrong thing.
 *
 * STAFF MODE OFF MEANS SILENT, never "fall through to the customer
 * assistant". Falling through re-creates the WhatsApp bug PR #1632 fixed,
 * through the settings page: the owner turns the feature off and gets
 * pitched by their own sales agent instead.
 */

import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import { logger } from "@/lib/logger";
import {
  loadOwnerSurfaceContext,
  type BusinessMetaRow,
  type OwnerSurfaceContext
} from "./context";
import { ownerSurfaceToolGates } from "./gates";
import { staffModeEnabled } from "./staff-mode";
import { buildOwnerSurfaceSystem } from "./system";
import { ownerTurnSurface, type OwnerTurnSurfaceKey } from "./turn-surfaces";
import type { SurfaceSpeaker } from "./speaker";

/** One replayed line of the conversation, oldest first. */
export type OwnerSurfaceTurnMessage = {
  role: "user" | "assistant";
  content: string;
};

export type OwnerSurfaceTurnOutcome =
  /**
   * The coworker answered.
   *
   * `reply` is clipped to the surface's limit and is what a caller sends.
   * `unclipped` is the same answer before the clip, and exists for the two
   * surfaces that must post-process the text first: SMS and Slack both run
   * `fulfillOwnerEmailBlocks` over the reply, and clipping BEFORE that can
   * cut an EMAIL_SEND block into an unparseable fragment which then leaks
   * to the owner verbatim. Those callers fulfil against `unclipped` and
   * clip the result themselves.
   */
  | { kind: "reply"; reply: string; unclipped: string }
  /**
   * The owner switched this surface off. Say NOTHING, and do not retry:
   * the answer cannot change until they switch it back on.
   */
  | { kind: "silent"; reason: string }
  /**
   * Over the shared AI spend cap. Its own case rather than a `failed`,
   * because a surface with somewhere to post (Slack) owes the speaker an
   * honest line, while a surface without one (SMS, WhatsApp) stays quiet.
   * Terminal either way.
   */
  | { kind: "over_cap" }
  /**
   * The turn did not produce a reply. `terminal` says whether retrying
   * could ever change the answer: "there is nothing to answer" cannot, and
   * burning three attempts on it dead-letters the job under a misleading
   * code.
   *
   * `code` is the short, stable reason a queue-backed caller files in its
   * job row's `error_code`, kept distinct from the free-text `detail` so a
   * model failure and an empty reply stay tellable apart when someone is
   * reading dead letters weeks later.
   */
  | { kind: "failed"; detail: string; code: string; terminal?: boolean };

export type OwnerSurfaceTurnArgs = {
  businessId: string;
  surfaceKey: OwnerTurnSurfaceKey;
  /**
   * Already resolved by the caller, because each channel proves identity
   * its own way (a WhatsApp wa_id, a Slack profile email, a Telegram
   * shared contact). This never guesses.
   */
  speaker: SurfaceSpeaker;
  /** How to name the speaker's channel identity: a number, a handle. */
  speakerRef: string;
  /**
   * Oldest first. The LAST row must be the user's: it is the message being
   * answered, and everything before it is replayed as context. Answering it
   * AND replaying it would show the model the same question twice.
   */
  history: readonly OwnerSurfaceTurnMessage[];
  /**
   * How the replayed transcript labels the human side, e.g. "Owner".
   * The assistant side is always "Coworker".
   */
  speakerLabel: string;
  /** Channel marker on the answered message, e.g. "Telegram from owner Sam". */
  userLabel: string;
  /**
   * Called once, immediately before the model call, and ONLY when the turn
   * is really going to run.
   *
   * This exists because "about to spend a model call" is a moment only this
   * function knows, and a caller that guesses it gets it wrong. Slack opens
   * its stream and sets its "is thinking" indicator here: opening either one
   * earlier would put an empty message and a spinner in the workspace for
   * the verdicts that are supposed to produce nothing at all, which is how
   * a switched-off surface ends up announcing itself. Bugbot caught exactly
   * that on PR #1714.
   */
  onTurnStart?: () => void | Promise<void>;
  /** Slack streams its reply; the other surfaces have nowhere to stream to. */
  onTextDelta?: (text: string) => void;
  /**
   * Audit identity for MCP-bridged tool calls. Slack passes its real
   * `slack:<user id>`; surfaces with no per-user id fall back to the
   * generic `<surface>-owner-operator` the context module supplies.
   */
  bridgeUserId?: string;
  /**
   * The business's timezone, tier and owner email, when the caller already
   * read that row. Saves a duplicate read on Slack, which fetches it for
   * the owner's UI locale before the turn begins.
   */
  businessMeta?: BusinessMetaRow;
};

export type OwnerSurfaceTurnDeps = {
  isStaffModeEnabled?: typeof staffModeEnabled;
  loadContext?: typeof loadOwnerSurfaceContext;
  runTurn?: typeof runInlineChatTurn;
};

/** How much of each replayed line the model sees. */
const TRANSCRIPT_LINE_MAX_CHARS = 500;

export async function runOwnerSurfaceTurn(
  args: OwnerSurfaceTurnArgs,
  deps: OwnerSurfaceTurnDeps = {}
): Promise<OwnerSurfaceTurnOutcome> {
  const { businessId, surfaceKey, speaker, speakerRef } = args;
  /* c8 ignore start -- production defaults; tests inject */
  const isStaffModeEnabled = deps.isStaffModeEnabled ?? staffModeEnabled;
  const loadContext = deps.loadContext ?? loadOwnerSurfaceContext;
  const runTurn = deps.runTurn ?? runInlineChatTurn;
  /* c8 ignore stop */

  const surface = ownerTurnSurface(surfaceKey);

  // Ask BEFORE spending a single context read. staffModeEnabled fails OPEN
  // by design (a blip must not silence the owner), so this cannot lock a
  // working surface shut on a bad day.
  if (!(await isStaffModeEnabled(businessId, surfaceKey))) {
    return { kind: "silent", reason: "staff_mode_off" };
  }

  // The last row has to be theirs. A trailing assistant row means the turn
  // is already closed, usually because a human answered by hand from the
  // provider's own inbox, and following up on top of them talks over a
  // colleague.
  const lastIndex = args.history.length - 1;
  if (lastIndex < 0 || args.history[lastIndex].role !== "user") {
    return { kind: "failed", detail: "no_input", code: "no_input", terminal: true };
  }
  const text = args.history[lastIndex].content.trim();
  if (!text) return { kind: "failed", detail: "no_input", code: "no_input", terminal: true };

  const transcript = args.history
    .slice(0, lastIndex)
    .map(
      (m) =>
        `[${m.role === "user" ? args.speakerLabel : "Coworker"}]: ${m.content.slice(
          0,
          TRANSCRIPT_LINE_MAX_CHARS
        )}`
    )
    .join("\n");

  let context: OwnerSurfaceContext;
  try {
    context = await loadContext(businessId, surface, speaker, {}, {
      bridgeUserId: args.bridgeUserId,
      meta: args.businessMeta
    });
  } catch (err) {
    return {
      kind: "failed",
      detail: err instanceof Error ? err.message : String(err),
      code: "context_load_failed"
    };
  }
  // Over the shared cap this surface declines rather than degrading. There
  // is no Rowboat fallback on any owner surface.
  if (context.overCap) return { kind: "over_cap" };

  // Everything above this line can decline without costing anything and
  // without the speaker seeing a thing. Past it, the turn is real.
  await args.onTurnStart?.();

  const inline = await runTurn({
    businessId,
    systemInstruction: buildOwnerSurfaceSystem({
      surface,
      speaker,
      speakerRef,
      emailToolEnabled: context.emailToolEnabled,
      timezone: context.timezone,
      integrationsLine: context.integrationsLine,
      bookingLinkLine: context.bookingLinkLine,
      businessContextBlock: context.businessContextBlock,
      bridgeToolsDeclared: Boolean(context.bridgeExtraTools),
      transcript
    }),
    userMessage: `[${args.userLabel}] ${text}`,
    knowledgeToolEnabled: context.knowledgeToolEnabled,
    extraTools: context.bridgeExtraTools,
    includeCreationTools: false,
    maxToolSteps: surface.maxToolSteps,
    budgetMs: surface.budgetMs,
    spendSurface: surface.spendSurface,
    flowEditSource: surface.flowEditSource,
    flowEditActor: speakerRef,
    // By message the coworker can change what an automation SAYS. Changing
    // what it DOES needs the owner looking at the flow, so structural edits
    // refuse here and point at the dashboard.
    flowEditSurfaceKind: "text",
    onTextDelta: args.onTextDelta,
    actionToolGates: ownerSurfaceToolGates({
      toolStates: context.toolStates,
      isOwner: speaker.kind === "owner",
      whatsappConnected: context.whatsappConnected
    })
  });

  if (!inline.ok) {
    logger.warn("owner surface turn: inline turn failed", {
      businessId,
      surface: surfaceKey,
      error: inline.error,
      detail: inline.detail
    });
    return {
      kind: "failed",
      detail: inline.detail ?? inline.error ?? "turn_failed",
      code: inline.error ?? "model_failed"
    };
  }
  const reply = inline.content.trim();
  // An empty reply is a failure, not a message: sending a blank message is
  // worse than retrying.
  if (!reply) return { kind: "failed", detail: "empty_reply", code: "empty" };
  return {
    kind: "reply",
    reply: reply.slice(0, surface.replyMaxChars),
    unclipped: reply
  };
}
