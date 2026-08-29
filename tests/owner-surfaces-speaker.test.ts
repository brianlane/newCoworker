import { describe, expect, it, vi } from "vitest";
import {
  resolveSurfaceSpeaker,
  type ResolveSpeakerDeps
} from "@/lib/owner-surfaces/speaker";
import type { TeamMemberRow } from "@/lib/db/employees";

/**
 * Who is speaking on an owner-capable surface.
 *
 * The existing answer to this question lives in two places that cannot see
 * each other: telnyx-sms-inbound classifies the SMS sender in Deno, and
 * resolveContactNames labels numbers for the dashboard. WhatsApp had no
 * answer at all, so the owner reached their own SALES assistant.
 *
 * The fail direction is the opposite of staff_numbers.ts on purpose, and
 * that is the single most important property here. That module answers
 * "may we text/tag/dial this person", where guessing STAFF is safe because
 * it withholds an action. This module answers "does this person get
 * owner-power tools", where guessing OWNER hands send_sms, roster CRUD and
 * flow edits to whoever is on the other end. So a failed lookup resolves to
 * `customer`.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

function member(overrides: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return {
    id: "m1",
    business_id: BIZ,
    name: "Dana Ruiz",
    phone_e164: "+15145550100",
    email: null,
    active: true,
    last_offered_at: null,
    weekly_schedule: null,
    preferred_windows: null,
    routing_enabled: true,
    named_routing_enabled: true,
    named_broadcast_enabled: true,
    team_broadcast_enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

/** Owner cell +15145188192, one active teammate on +15145550100. */
function deps(overrides: ResolveSpeakerDeps = {}): ResolveSpeakerDeps {
  return {
    fetchOwnerNumbers: vi.fn(async () => ["+15145188192"]),
    fetchRoster: vi.fn(async () => [member()]),
    fetchBusiness: vi.fn(async () => ({
      owner_name: "James Fung",
      owner_email: "james@kypads.com"
    })),
    ...overrides
  };
}

describe("resolveSurfaceSpeaker, by phone", () => {
  it("calls an owner number the owner, named from the business", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145188192" },
      deps()
    );
    expect(speaker).toEqual({ kind: "owner", name: "James Fung", readFailed: false });
  });

  it("normalizes both sides, so a loose NANP form still matches", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "(514) 518-8192" },
      deps()
    );
    expect(speaker.kind).toBe("owner");
  });

  it("calls an active roster number a teammate, named from the roster", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145550100" },
      deps()
    );
    expect(speaker).toEqual({ kind: "teammate", name: "Dana Ruiz", readFailed: false });
  });

  it("prefers the roster name but keeps the OWNER kind when a number is both", async () => {
    // The SMS path already does exactly this: a roster name is usually more
    // specific than the generic businesses.owner_name, but the KIND decides
    // which tools get declared, so owner has to win it.
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145188192" },
      deps({ fetchRoster: async () => [member({ phone_e164: "+15145188192", name: "James F." })] })
    );
    expect(speaker).toEqual({ kind: "owner", name: "James F.", readFailed: false });
  });

  it("treats a DEACTIVATED roster member as a customer", async () => {
    // Deliberately stricter than staff_numbers.ts, which counts a
    // deactivated broker as staff so we never cold-call them. Withholding a
    // sales script is harmless; handing a former employee the roster and
    // flow-edit tools is not.
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145550100" },
      deps({ fetchRoster: async () => [member({ active: false })] })
    );
    expect(speaker.kind).toBe("customer");
  });

  it("calls an unknown number a customer", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+16045551212" },
      deps()
    );
    expect(speaker).toEqual({ kind: "customer", name: null, readFailed: false });
  });
});

describe("resolveSurfaceSpeaker, by email", () => {
  it("matches the owner email case-insensitively", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { email: "James@KYPads.com" },
      deps()
    );
    expect(speaker.kind).toBe("owner");
  });

  it("matches a roster email case-insensitively", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { email: "DANA@kypads.com" },
      deps({ fetchRoster: async () => [member({ email: "dana@KYPads.com" })] })
    );
    expect(speaker).toEqual({ kind: "teammate", name: "Dana Ruiz", readFailed: false });
  });

  it("never matches a roster row whose email is blank", async () => {
    // A roster row with a whitespace email must not become a wildcard that
    // hands teammate powers to whoever writes in next.
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { email: "stranger@example.com" },
      deps({ fetchRoster: async () => [member({ email: "  " })] })
    );
    expect(speaker.kind).toBe("customer");
  });
});

describe("resolveSurfaceSpeaker, fail-closed", () => {
  it("resolves to customer, flagged, when the owner-number read throws", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145188192" },
      deps({
        fetchOwnerNumbers: async () => {
          throw new Error("db down");
        }
      })
    );
    expect(speaker).toEqual({ kind: "customer", name: null, readFailed: true });
  });

  it("resolves to customer, flagged, when the roster read throws", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145550100" },
      deps({
        fetchRoster: async () => {
          throw new Error("db down");
        }
      })
    );
    expect(speaker).toEqual({ kind: "customer", name: null, readFailed: true });
  });

  it("survives a rejection that is not an Error", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145188192" },
      deps({ fetchRoster: async () => Promise.reject("roster exploded") })
    );
    expect(speaker).toEqual({ kind: "customer", name: null, readFailed: true });
  });

  it("resolves to customer when no identity is supplied at all", async () => {
    const speaker = await resolveSurfaceSpeaker(BIZ, {}, deps());
    expect(speaker).toEqual({ kind: "customer", name: null, readFailed: false });
  });

  it("does no lookups at all when there is no identity", async () => {
    const fetchOwnerNumbers = vi.fn(async () => ["+15145188192"]);
    await resolveSurfaceSpeaker(BIZ, { phoneE164: "  ", email: null }, deps({ fetchOwnerNumbers }));
    expect(fetchOwnerNumbers).not.toHaveBeenCalled();
  });
});

describe("resolveSurfaceSpeaker, names it cannot find", () => {
  it("still calls the owner the owner when the business row is unreadable", async () => {
    // The number is owner-verified on its own; a missing businesses row only
    // costs us the label, and inventing one would be worse than none.
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145188192" },
      deps({ fetchBusiness: async () => null })
    );
    expect(speaker).toEqual({ kind: "owner", name: null, readFailed: false });
  });

  it("returns a null name rather than a blank one for the owner", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145188192" },
      deps({
        fetchRoster: async () => [member({ phone_e164: "+15145188192", name: "   " })],
        fetchBusiness: async () => ({ owner_name: "  ", owner_email: null })
      })
    );
    expect(speaker).toEqual({ kind: "owner", name: null, readFailed: false });
  });

  it("returns a null name rather than a blank one for a teammate", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145550100" },
      deps({ fetchRoster: async () => [member({ name: "  " })] })
    );
    expect(speaker).toEqual({ kind: "teammate", name: null, readFailed: false });
  });

  it("ignores a roster row that carries no phone at all", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+16045551212" },
      deps({ fetchRoster: async () => [member({ phone_e164: "" })] })
    );
    expect(speaker.kind).toBe("customer");
  });
});

describe("an account identified only by a channel binding", () => {
  /**
   * Telegram carries neither a phone nor an email, so a recorded binding is
   * the only thing that can answer "who is this". These cases exist because
   * getting them wrong hands owner powers to a stranger, or strips them
   * from a colleague who still works here.
   */
  const REF = { channel: "telegram" as const, externalUserId: "4242" };

  function bound(overrides: Record<string, unknown> = {}) {
    return {
      id: "ident-1",
      business_id: BIZ,
      channel: "telegram",
      external_user_id: "4242",
      employee_id: null,
      is_owner: false,
      verified_phone_e164: null,
      verified_email: null,
      linked_via: "link_code",
      ...overrides
    } as never;
  }

  it("treats an UNBOUND account as a customer, which means silence", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { externalRef: REF },
      {
        fetchOwnerNumbers: async () => [],
        fetchRoster: async () => [],
        fetchBusiness: async () => ({ owner_name: "Amy", owner_email: "amy@x.co" }),
        fetchChannelIdentity: async () => null
      }
    );
    expect(speaker).toEqual({ kind: "customer", name: null, readFailed: false });
  });

  it("promotes a binding marked as the owner", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { externalRef: REF },
      {
        fetchOwnerNumbers: async () => [],
        fetchRoster: async () => [],
        fetchBusiness: async () => ({ owner_name: "Amy", owner_email: "amy@x.co" }),
        fetchChannelIdentity: async () => bound({ is_owner: true })
      }
    );
    expect(speaker).toMatchObject({ kind: "owner", name: "Amy" });
  });

  it("resolves a code-linked teammate through the roster row it names", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { externalRef: REF },
      {
        fetchOwnerNumbers: async () => [],
        fetchRoster: async () => [
          { id: "emp-1", name: "Dana Ruiz", active: true, phone_e164: "+1555", email: null } as never
        ],
        fetchBusiness: async () => ({ owner_name: "Amy", owner_email: "amy@x.co" }),
        fetchChannelIdentity: async () => bound({ employee_id: "emp-1" })
      }
    );
    expect(speaker).toMatchObject({ kind: "teammate", name: "Dana Ruiz" });
  });

  it("DEMOTES a binding whose roster row was deactivated", async () => {
    // Somebody who left keeps their Telegram account. The binding outliving
    // their employment must not outlive their powers.
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { externalRef: REF },
      {
        fetchOwnerNumbers: async () => [],
        fetchRoster: async () => [
          { id: "emp-1", name: "Dana Ruiz", active: false, phone_e164: "+1555", email: null } as never
        ],
        fetchBusiness: async () => ({ owner_name: "Amy", owner_email: "amy@x.co" }),
        fetchChannelIdentity: async () => bound({ employee_id: "emp-1" })
      }
    );
    expect(speaker.kind).toBe("customer");
  });

  it("demotes a binding naming a roster row that no longer exists", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { externalRef: REF },
      {
        fetchOwnerNumbers: async () => [],
        fetchRoster: async () => [],
        fetchBusiness: async () => ({ owner_name: "Amy", owner_email: "amy@x.co" }),
        fetchChannelIdentity: async () => bound({ employee_id: "gone" })
      }
    );
    expect(speaker.kind).toBe("customer");
  });

  it("fails CLOSED when the binding cannot be read", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { externalRef: REF },
      {
        fetchOwnerNumbers: async () => [],
        fetchRoster: async () => [],
        fetchBusiness: async () => null,
        fetchChannelIdentity: async () => {
          throw new Error("identities down");
        }
      }
    );
    expect(speaker).toEqual({ kind: "customer", name: null, readFailed: true });
  });

  it("prefers a roster name over the binding's own when both are present", async () => {
    // A contact-linked owner arrives with BOTH a phone and a ref; the
    // roster name is more specific than businesses.owner_name.
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { phoneE164: "+15145188192", externalRef: REF },
      {
        fetchOwnerNumbers: async () => ["+15145188192"],
        fetchRoster: async () => [
          { id: "emp-1", name: "Amy Laidlaw", active: true, phone_e164: "+15145188192", email: null } as never
        ],
        fetchBusiness: async () => ({ owner_name: "Amy", owner_email: "amy@x.co" }),
        fetchChannelIdentity: async () => bound({ is_owner: true, employee_id: "emp-1" })
      }
    );
    expect(speaker).toMatchObject({ kind: "owner", name: "Amy Laidlaw" });
  });

  it("names an owner from the BINDING's roster row when nothing else has one", async () => {
    const speaker = await resolveSurfaceSpeaker(
      BIZ,
      { externalRef: REF },
      {
        fetchOwnerNumbers: async () => [],
        fetchRoster: async () => [
          { id: "emp-1", name: "Amy Laidlaw", active: true, phone_e164: "+1555", email: null } as never
        ],
        fetchBusiness: async () => ({ owner_name: null, owner_email: null }),
        fetchChannelIdentity: async () => bound({ is_owner: true, employee_id: "emp-1" })
      }
    );
    expect(speaker).toMatchObject({ kind: "owner", name: "Amy Laidlaw" });
  });
});
