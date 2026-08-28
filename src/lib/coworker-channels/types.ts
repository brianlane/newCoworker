/**
 * What a coworker channel has to supply, and deliberately nothing more.
 *
 * The temptation when generalising Slack is to lift its whole shape into an
 * interface: load a connection, resolve an identity, set a typing
 * indicator, open a stream, append to it, close it, post a fallback. That
 * interface would have exactly one implementation that used all of it.
 * Streaming and the "is thinking" indicator are Slack features; identity is
 * a verified profile email on Slack, a Workspace address on Google Chat, an
 * Entra object id on Teams, and a shared contact card on Telegram. Forcing
 * those through one signature buys indirection, not reuse.
 *
 * So the seam is drawn where the duplication actually was. Three things
 * were genuinely copied between channels and are now shared:
 *
 *   - the queue mechanics (claim, bounded batch, crash handling, reclaim)
 *     in `worker.ts`
 *   - the store (`db/coworker-chat.ts`)
 *   - the turn itself (`owner-surfaces/run-turn.ts`)
 *
 * Everything a channel does differently stays inside its own `runJob`.
 */

import type { CoworkerChannel, CoworkerJobRow } from "@/lib/db/coworker-chat";

export type CoworkerChannelAdapter = {
  channel: CoworkerChannel;
  /**
   * Run one claimed job to a terminal state. The adapter owns posting the
   * answer and closing the job out (complete or fail), because only it
   * knows how its provider says things.
   *
   * Returns true when the speaker got an answer, false otherwise. That is a
   * batch-accounting signal, NOT an error flag: a job that terminates
   * honestly without a reply (the surface is switched off, the tenant is
   * over its cap and was told so) is a normal outcome. Throwing is what
   * signals "unexpected", and the shared loop turns a throw into a
   * retryable `worker_crash`.
   */
  runJob(job: CoworkerJobRow): Promise<boolean>;
};
