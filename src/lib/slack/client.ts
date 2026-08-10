/**
 * Thin Slack Web API client, hand-rolled fetch like src/lib/meta/client.ts:
 * no SDK dependency, JSON POSTs with the workspace's bot token, and Slack's
 * "HTTP 200 + ok:false" error style surfaced as a typed result instead of a
 * throw (callers decide what a Slack-side refusal means for them).
 *
 * Network-level failures DO throw (SlackApiError) so a dead upstream is
 * distinguishable from "Slack said no".
 */
import { SLACK_API_BASE_URL, SLACK_REQUEST_TIMEOUT_MS } from "@/lib/slack/oauth";

export class SlackApiError extends Error {
  constructor(
    public readonly code: "upstream_timeout" | "upstream_unreachable" | "bad_response",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

type SlackApiEnvelope = { ok?: boolean; error?: string } & Record<string, unknown>;

/**
 * POST https://slack.com/api/<method> with a JSON body. Returns the parsed
 * envelope (ok:true or ok:false+error); throws SlackApiError only on
 * transport failures or an unparseable body.
 */
export async function slackApiCall(
  method: string,
  botToken: string,
  payload: Record<string, unknown>
): Promise<SlackApiEnvelope> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), SLACK_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${SLACK_API_BASE_URL}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload),
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new SlackApiError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? `Slack ${method} timed out` : `Slack ${method} unreachable`
    );
  } finally {
    clearTimeout(timeout);
  }

  const body = (await res.json().catch(() => null)) as SlackApiEnvelope | null;
  if (body === null) {
    throw new SlackApiError("bad_response", `Slack ${method} returned a non-JSON body`, res.status);
  }
  return body;
}

export type SlackPostMessageResult =
  | { ok: true; ts: string; channel: string }
  | { ok: false; error: string };

/** chat.postMessage: plain text and/or Block Kit blocks, optional thread. */
export async function slackPostMessage(
  botToken: string,
  input: {
    channel: string;
    text: string;
    blocks?: unknown[];
    thread_ts?: string;
  }
): Promise<SlackPostMessageResult> {
  const body = await slackApiCall("chat.postMessage", botToken, {
    channel: input.channel,
    text: input.text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
    ...(input.thread_ts ? { thread_ts: input.thread_ts } : {})
  });
  if (body.ok !== true) {
    return { ok: false, error: typeof body.error === "string" ? body.error : "unknown_error" };
  }
  return {
    ok: true,
    ts: typeof body.ts === "string" ? body.ts : "",
    channel: typeof body.channel === "string" ? body.channel : input.channel
  };
}

export type SlackChannelSummary = {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
};

/**
 * conversations.list for the alert-channel picker: public + private channels
 * the workspace exposes to the bot, first page only (200 covers the small
 * businesses this product serves; the picker also accepts a channel the bot
 * was @invited to that a later page would have shown, because the hello-post
 * PATCH is the real gate, not this listing).
 */
export async function slackListChannels(botToken: string): Promise<SlackChannelSummary[]> {
  const body = await slackApiCall("conversations.list", botToken, {
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: 200
  });
  if (body.ok !== true || !Array.isArray(body.channels)) return [];
  const out: SlackChannelSummary[] = [];
  for (const raw of body.channels) {
    const ch = raw as { id?: unknown; name?: unknown; is_private?: unknown; is_member?: unknown };
    if (typeof ch.id !== "string" || typeof ch.name !== "string") continue;
    out.push({
      id: ch.id,
      name: ch.name,
      is_private: ch.is_private === true,
      is_member: ch.is_member === true
    });
  }
  return out;
}
