import { describe, expect, it } from "vitest";

/**
 * The channel registry.
 *
 * Small, but it decides whether a queued job can run at all, so the two
 * things worth pinning are that every registered channel is reachable by
 * its own key, and that an unknown key answers null rather than throwing.
 * Throwing here would take down a whole worker pass over one bad row.
 */

import { coworkerAdapterFor } from "@/lib/coworker-channels/registry";

describe("coworkerAdapterFor", () => {
  it("finds Slack under its own key, and hands back ITS adapter", () => {
    // The channel this pipeline was extracted from. If it ever falls out of
    // the registry, every queued Slack job fails as unknown_channel, which
    // is silent in the workspace and loud only in a job row nobody reads.
    expect(coworkerAdapterFor("slack")?.channel).toBe("slack");
  });

  it("answers null for a channel nobody implements, rather than throwing", () => {
    // A row written by removed code, or a half-rolled deploy. The worker
    // fails that ONE job terminally and keeps draining.
    expect(coworkerAdapterFor("telegram")).toBeNull();
    expect(coworkerAdapterFor("")).toBeNull();
  });
});
