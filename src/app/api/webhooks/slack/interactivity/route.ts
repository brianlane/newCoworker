/**
 * Slack interactivity receiver: the approval-gate buttons.
 *
 * Same raw-body signature verification as the events endpoint (Slack signs
 * the form-encoded body with the identical v0 scheme), and the same
 * 3-second ack expectation. The press is applied inline (a couple of DB
 * reads and one users.info); the card rewrite and any ephemeral notes go
 * out through `response_url` via after(), which Slack allows 5 times in 30
 * minutes with `replace_original` semantics.
 *
 * Identity is the whole game here: only the workspace member whose
 * verified Slack email matches the business owner may decide a gate, the
 * same trust bar as the Telnyx owner-number check and the dashboard
 * session. Everyone else gets an ephemeral "only the owner" note and the
 * card stays live for the owner.
 */
import { after } from "next/server";
import { errorResponse, successResponse } from "@/lib/api-response";
import {
  parseSlackInteractionPayload,
  SLACK_WEBHOOK_MAX_BODY_BYTES,
  verifySlackSignature
} from "@/lib/slack/webhook";
import { getSlackConnectionByTeamId } from "@/lib/db/slack-connections";
import { slackUsersInfo } from "@/lib/slack/client";
import { getBusiness } from "@/lib/db/businesses";
import {
  applySlackApprovalDecision,
  slackApprovalAck
} from "@/lib/slack/approvals";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Best-effort response_url post; failures only cost the visual update. */
async function respond(url: string | null, body: Record<string, unknown>): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    logger.warn("slack interactivity: response_url post failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > SLACK_WEBHOOK_MAX_BODY_BYTES) {
    return errorResponse("VALIDATION_ERROR", "payload too large (256KB max)", 413);
  }
  const verified = verifySlackSignature({
    rawBody,
    timestampHeader: request.headers.get("x-slack-request-timestamp"),
    signatureHeader: request.headers.get("x-slack-signature")
  });
  if (!verified) {
    return errorResponse("UNAUTHORIZED", "Invalid webhook signature");
  }

  const action = parseSlackInteractionPayload(rawBody);
  if (!action || !action.actionId.startsWith("aiflow_approval:")) {
    // Authentic but not a press we own: ack so Slack shows no error.
    return successResponse({ ignored: true });
  }

  let value: { r?: unknown; o?: unknown };
  try {
    value = JSON.parse(action.value);
  } catch {
    return successResponse({ ignored: true });
  }
  const runId = typeof value.r === "string" ? value.r : null;
  const option = typeof value.o === "string" ? value.o : null;
  if (!runId || !option) return successResponse({ ignored: true });

  const connection = await getSlackConnectionByTeamId(action.teamId).catch(() => null);
  if (!connection || !connection.is_active || connection.botToken.length === 0) {
    return successResponse({ ignored: true });
  }

  // Owner check, fresh per press: a decision is exactly the moment a stale
  // cache must not answer.
  const [identity, business] = await Promise.all([
    slackUsersInfo(connection.botToken, action.userId).catch(() => null),
    getBusiness(connection.business_id).catch(() => null)
  ]);
  const ownerEmail = (business?.owner_email ?? "").trim().toLowerCase();
  const isOwner =
    ownerEmail.length > 0 &&
    (identity?.email ?? "").trim().toLowerCase() === ownerEmail;
  if (!isOwner) {
    after(() =>
      respond(action.responseUrl, {
        response_type: "ephemeral",
        replace_original: false,
        text: "Only the business owner can decide this approval."
      })
    );
    return successResponse({ refused: "not_owner" });
  }

  let outcome;
  try {
    outcome = await applySlackApprovalDecision({
      businessId: connection.business_id,
      runId,
      option,
      decidedBy: `slack:${action.userId}`
    });
  } catch (err) {
    logger.error("slack interactivity: decision failed", {
      businessId: connection.business_id,
      runId,
      error: err instanceof Error ? err.message : String(err)
    });
    after(() =>
      respond(action.responseUrl, {
        response_type: "ephemeral",
        replace_original: false,
        text: "That didn't stick, try the button again in a moment."
      })
    );
    return successResponse({ error: "decision_failed" });
  }

  const ack = slackApprovalAck(outcome);
  const decider = action.userName ? ` (${action.userName})` : "";
  const canceled =
    outcome.applied && outcome.kind === "decision" && outcome.option === "cancel";
  after(() =>
    respond(
      action.responseUrl,
      outcome.applied
        ? { replace_original: true, text: `${canceled ? "🛑" : "✅"} ${ack}${decider}` }
        : { response_type: "ephemeral", replace_original: false, text: ack }
    )
  );
  return successResponse({ applied: outcome.applied });
}
