import { describe, expect, it } from "vitest";
import {
  buildClassifyPrompt,
  buildExtractionPrompt,
  parseClassifyChoice,
  parseExtractionJson
} from "../../supabase/functions/_shared/ai_flows/engine";
import { geminiJson } from "./gemini";

/**
 * The two AI-decision steps every serious flow leans on — extract_text and
 * classify — against the LIVE model with the worker's exact prompts, parsers,
 * and generation config. Unit tests pin the prompt/parser logic with scripted
 * responses; this layer pins that the real model, given those prompts,
 * actually returns decisions the parsers accept and the flows route on.
 */

const TRULY_CATEGORIES = [
  {
    value: "wants_a_call",
    description: "asks to talk to someone, book, schedule, or be called now"
  },
  {
    value: "not_interested",
    description: "declines, says they're all set, or asks to stop texting"
  },
  {
    value: "gave_info",
    description: "answered the question - a reason, renewal timing, or other details"
  }
];

const CLASSIFY_QUESTION =
  "A new insurance lead was just asked what prompted them to shop around today. This is their reply.";

async function classify(text: string): Promise<string> {
  const raw = await geminiJson(buildClassifyPrompt(TRULY_CATEGORIES, text, CLASSIFY_QUESTION));
  return parseClassifyChoice(raw, TRULY_CATEGORIES);
}

describe("classify step live", () => {
  it(
    "reads Dwight's production reply as gave_info (the incident's routing decision)",
    { retry: 1, timeout: 60_000 },
    async () => {
      expect(
        await classify(
          "I'm tired of insurance refusing to I've me insurance because of this no fault " +
            "accident crappie now because now I have to take a bus to work which cost to much " +
            "money.Now my truck has been parked since April 17th and I still have to make " +
            "payments on it. DWIGHT"
        )
      ).toBe("gave_info");
    }
  );

  it(
    "routes an explicit call request to wants_a_call",
    { retry: 1, timeout: 60_000 },
    async () => {
      expect(await classify("Yes — please have a broker call me right away today.")).toBe(
        "wants_a_call"
      );
    }
  );

  it(
    "routes an opt-out to not_interested",
    { retry: 1, timeout: 60_000 },
    async () => {
      expect(await classify("Please stop texting me, I'm all set with my current provider.")).toBe(
        "not_interested"
      );
    }
  );

  it(
    "classifies EVERY first reply recorded in Truly's run history the way production did",
    { retry: 1, timeout: 120_000 },
    async () => {
      // The complete distinct set of real lead first-replies from
      // ai_flow_runs for flow 70be1676 (as of 2026-07-14), with the intent
      // production recorded. New recorded replies belong in this corpus.
      const recorded: Array<[string, string]> = [
        ["Hi i am looking for a auto quote", "gave_info"], // Junaid 2b7ce0c7
        ["I need Auto and home insurance quote", "gave_info"], // Shahid 38d17410
        ["I need auto insurance ", "gave_info"], // Juhu 70d90bc7
        ["I am looking for auto insurance", "gave_info"] // Alex 5820f7f0
      ];
      for (const [reply, intent] of recorded) {
        expect(await classify(reply), reply).toBe(intent);
      }
    }
  );

  it(
    "classifies Dawnia's recorded late reply as wants_a_call under the late-fork question",
    { retry: 1, timeout: 60_000 },
    async () => {
      // Run 5575c2b2: the reply the pre-patch dead end dropped. The late
      // fork uses its own question wording — pin the recorded utterance
      // against THAT prompt, not the first-reply one.
      const raw = await geminiJson(
        buildClassifyPrompt(
          TRULY_CATEGORIES,
          "I would like to book a call ",
          "An insurance lead was nudged about reviewing their options. This is their reply."
        )
      );
      expect(parseClassifyChoice(raw, TRULY_CATEGORIES)).toBe("wants_a_call");
    }
  );
});

describe("extract_text step live", () => {
  it(
    "pulls the lead identity out of a Privyr-style lead email",
    { retry: 1, timeout: 60_000 },
    async () => {
      const fields = [
        { name: "lead_name", description: "The lead's full name" },
        { name: "lead_phone", description: "The lead's phone number" },
        { name: "lead_email", description: "The lead's email address" },
        { name: "product", description: "What they want to insure (auto, home, business...)" }
      ];
      const email = [
        "New lead: Dwight Colclough",
        "You have a new lead from your campaign.",
        "",
        "Name: Dwight Colclough",
        "Phone: +14168775223",
        "Email: dwight.colclough@amresupply.com",
        "Interested in: Auto insurance quote",
        "",
        "Sent via Privyr"
      ].join("\n");
      const raw = await geminiJson(buildExtractionPrompt(fields, email));
      const out = parseExtractionJson(raw, fields);
      expect(out.lead_name).toMatch(/dwight/i);
      expect(out.lead_name).toMatch(/colclough/i);
      expect(out.lead_phone.replace(/\D/g, "")).toContain("4168775223");
      expect(out.lead_email.toLowerCase()).toBe("dwight.colclough@amresupply.com");
      expect(out.product).toMatch(/auto/i);
    }
  );

  it(
    "returns empty strings (not inventions) for fields the text does not contain",
    { retry: 1, timeout: 60_000 },
    async () => {
      const fields = [
        { name: "lead_name", description: "The lead's full name" },
        { name: "policy_number", description: "The lead's existing policy number" }
      ];
      const raw = await geminiJson(
        buildExtractionPrompt(fields, "New lead: Jane Roe wants a home insurance quote.")
      );
      const out = parseExtractionJson(raw, fields);
      expect(out.lead_name).toMatch(/jane/i);
      expect(out.policy_number).toBe("");
    }
  );
});
