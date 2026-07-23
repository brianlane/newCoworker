import { describe, expect, it } from "vitest";
import {
  buildExtractionPrompt,
  parseExtractionJson
} from "../../supabase/functions/_shared/ai_flows/engine";
import { withSelfNameRetryHint } from "../../supabase/functions/_shared/ai_flows/extracted_contact";
import { geminiJson } from "./gemini";

/**
 * The Pamela replay (Amy Laidlaw Real Estate, 2026-07-22): the "Clever Lead -
 * Group Reply" flow reads the seller's first name off Clever's group intro
 * and templates it into Amy's canned greeting. On Jul 22–23 the extractor
 * answered "Amy" — the tenant's own agent, mentioned four times in the
 * intro — instead of the seller (mentioned twice), so THREE sellers were
 * greeted "Hi Amy." (8/8 correct Jul 13–21, 0/3 after). The break lined up
 * with the Jul 21 model migration (PR #809, gemini-2.5-flash-lite →
 * gemini-3.5-flash-lite), but incident probing on Jul 23 showed CURRENT
 * 2.5-flash-lite failing the identical prompt 4/4 — so pinning the old
 * model back was no mitigation (an upstream serving change is equally
 * plausible), and the durable fix is the prompt/description/retry layers
 * below, which probe correct on BOTH models.
 *
 * This suite replays the REAL trigger windowText through the worker's exact
 * prompt builder, parser, and generation config against the live model,
 * pinning all three layers of the fix:
 *   1. the person-role disambiguation instruction in buildExtractionPrompt
 *      (with the flow's ORIGINAL one-line field description);
 *   2. the sharpened field description the one-shot writes to the live flows
 *      (scripts/oneshot/patch-clever-group-reply-name-desc.ts);
 *   3. the worker's self-name retry hint (withSelfNameRetryHint) — the
 *      belt-and-suspenders path when a first pass still answers "Amy".
 */

/** Verbatim from run c53ed929 (ai_flow_runs.context.trigger.windowText). */
const CLEVER_INTRO =
  "Hi Pamela 👋 this is Team from Clever Real Estate!\r\n\r\n" +
  "In this group text, I'd like to introduce you to Amy Laidlaw,\r\n\r\n" +
  "They will provide you with the instant cash offer you requested, as well " +
  "as explain our 7 Day Sold program, to help sell your home quickly.\r\n\r\n" +
  "You can reach Amy at: ☎️: +16028053377 📧: amy@amylaidlaw.com Amy, when " +
  "is the earliest you'll be able to give Pamela a call?";

/** The flow's original description — what was live when the greeting broke. */
const ORIGINAL_FIELD = {
  name: "seller_first_name",
  description: "The seller's first name from the Clever intro message"
};

/** The sharpened description the one-shot patches into both live flows. */
const SHARPENED_FIELD = {
  name: "seller_first_name",
  description:
    "The seller's first name — the person Clever greets at the START of the " +
    'message ("Hi <name>") and asks the agent to call. ' +
    'NEVER "Amy" or "Amy Laidlaw": that is our own agent being introduced ' +
    "TO the seller, not the seller."
};

/** Amy's roster (businessSelfNames shape: owner + active team members). */
const SELF_NAMES = ["Amy Laidlaw", "Dave Lane"];

async function extractSellerFirstName(field: {
  name: string;
  description?: string;
}): Promise<string> {
  const raw = await geminiJson(buildExtractionPrompt([field], CLEVER_INTRO));
  return (parseExtractionJson(raw, [field]).seller_first_name ?? "").trim();
}

describe("Clever seller-name extraction replay — Pamela 2026-07-22", () => {
  it(
    "the hardened prompt extracts the SELLER with the original flow description",
    async () => {
      const name = await extractSellerFirstName(ORIGINAL_FIELD);
      expect(name.toLowerCase()).toBe("pamela");
    },
    120_000
  );

  it(
    "the sharpened one-shot description extracts the seller",
    async () => {
      const name = await extractSellerFirstName(SHARPENED_FIELD);
      expect(name.toLowerCase()).toBe("pamela");
    },
    120_000
  );

  it(
    "the self-name retry hint steers a suspect answer to the seller",
    async () => {
      // The worker path when a first pass answered "Amy": re-extract with the
      // hinted field list. The hint must yield the seller, not the agent.
      const [hinted] = withSelfNameRetryHint(
        [ORIGINAL_FIELD],
        ["seller_first_name"],
        SELF_NAMES
      );
      const name = await extractSellerFirstName(hinted);
      expect(name.toLowerCase()).toBe("pamela");
    },
    120_000
  );
});
