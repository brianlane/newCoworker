import { describe, expect, it } from "vitest";
import { scrubSelfPhones } from "../supabase/functions/_shared/ai_flows/extracted_contact";

const BUSINESS_DID = "+16028053377";
const OWNER_CELL = "+16026951142";

describe("scrubSelfPhones", () => {
  it("clears extracted values that match a self number (any formatting) and reports them", () => {
    const { values, cleared } = scrubSelfPhones(
      {
        lead_name: "Amy",
        lead_phone: "(602) 805-3377", // the business DID in page formatting
        lead_email: "none",
        alt_phone: OWNER_CELL
      },
      [BUSINESS_DID, OWNER_CELL]
    );
    expect(values.lead_phone).toBe("");
    expect(values.alt_phone).toBe("");
    expect(cleared.sort()).toEqual(["alt_phone", "lead_phone"]);
    // Non-phone values are never touched — even ones as suspicious as "Amy".
    expect(values.lead_name).toBe("Amy");
    expect(values.lead_email).toBe("none");
  });

  it("keeps a legitimate lead phone VERBATIM and tolerates unparseable self numbers", () => {
    const { values, cleared } = scrubSelfPhones(
      { lead_phone: "(480) 600-8501", lead_address: "3536 E Elmwood St, Mesa, AZ 85213" },
      [BUSINESS_DID, "not-a-phone", ""]
    );
    // Surviving values are never rewritten — the scrub only clears matches.
    expect(values.lead_phone).toBe("(480) 600-8501");
    expect(values.lead_address).toBe("3536 E Elmwood St, Mesa, AZ 85213");
    expect(cleared).toEqual([]);
  });

  it("handles empty inputs", () => {
    expect(scrubSelfPhones({}, [BUSINESS_DID])).toEqual({ values: {}, cleared: [] });
    expect(scrubSelfPhones({ lead_phone: BUSINESS_DID }, [])).toEqual({
      values: { lead_phone: BUSINESS_DID },
      cleared: []
    });
  });
});
