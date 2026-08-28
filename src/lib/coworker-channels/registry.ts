/**
 * Every channel that runs a two-way coworker conversation, by key.
 *
 * Adding one is an entry here plus its `runJob`. The lookup returns null
 * rather than throwing on an unknown key, because the caller is the shared
 * worker draining a queue: a single unrunnable row must fail on its own
 * terms and let the batch continue, not take the pass down with it.
 */

import { slackChannelAdapter } from "@/lib/slack/worker";
import type { CoworkerChannelAdapter } from "./types";

const ADAPTERS: readonly CoworkerChannelAdapter[] = [slackChannelAdapter];

const BY_CHANNEL = new Map(ADAPTERS.map((a) => [a.channel as string, a]));

export function coworkerAdapterFor(channel: string): CoworkerChannelAdapter | null {
  return BY_CHANNEL.get(channel) ?? null;
}
