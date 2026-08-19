/**
 * manage_employee core (src/lib/employees/manage-tool.ts): the roster write
 * every owner surface shares.
 *
 * What the tests hold down, in the order the risk matters:
 *   1. it never writes to the WRONG person: ambiguity and unknown names
 *      report back instead of guessing;
 *   2. a bad number, a duplicate, or a failed write is reported honestly,
 *      never as success;
 *   3. the three availability flags round-trip, and the note tells the owner
 *      what they will actually observe.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { manageEmployee } from "@/lib/employees/manage-tool";
import type { TeamMemberRow } from "@/lib/db/employees";

const BIZ = "11111111-1111-4111-8111-111111111111";

function member(overrides: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    business_id: BIZ,
    name: "Gabrielle Mota",
    phone_e164: "+14807202013",
    email: null,
    active: true,
    last_offered_at: null,
    weekly_schedule: null,
    preferred_windows: null,
    routing_enabled: true,
    named_routing_enabled: true,
    named_broadcast_enabled: true,
    team_broadcast_enabled: true,
    created_at: "2026-06-10T00:52:26.492Z",
    ...overrides
  };
}

const DAVE = member({
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  name: "Dave Lane",
  phone_e164: "+16025245719"
});

function deps(roster: TeamMemberRow[], overrides: Record<string, unknown> = {}) {
  return {
    listMembers: vi.fn(async () => roster) as never,
    createMember: vi.fn(async (_biz: string, input: Record<string, unknown>) =>
      member({
        id: "aaaaaaaa-0000-4000-8000-00000000000f",
        name: String(input.name),
        phone_e164: String(input.phoneE164),
        email: (input.email as string | null) ?? null,
        routing_enabled: (input.routingEnabled as boolean) ?? true,
        named_routing_enabled: (input.namedRoutingEnabled as boolean) ?? true,
        named_broadcast_enabled: (input.namedBroadcastEnabled as boolean) ?? true,
        team_broadcast_enabled: (input.teamBroadcastEnabled as boolean) ?? true
      })
    ) as never,
    updateMember: vi.fn(async (_biz: string, id: string, patch: Record<string, unknown>) => {
      const base = roster.find((m) => m.id === id) ?? member();
      return {
        ...base,
        ...(patch.name !== undefined ? { name: patch.name as string } : {}),
        ...(patch.phoneE164 !== undefined ? { phone_e164: patch.phoneE164 as string } : {}),
        ...(patch.email !== undefined ? { email: patch.email as string | null } : {}),
        ...(patch.active !== undefined ? { active: patch.active as boolean } : {}),
        ...(patch.routingEnabled !== undefined
          ? { routing_enabled: patch.routingEnabled as boolean }
          : {}),
        ...(patch.namedRoutingEnabled !== undefined
          ? { named_routing_enabled: patch.namedRoutingEnabled as boolean }
          : {}),
        ...(patch.namedBroadcastEnabled !== undefined
          ? { named_broadcast_enabled: patch.namedBroadcastEnabled as boolean }
          : {}),
        ...(patch.teamBroadcastEnabled !== undefined
          ? { team_broadcast_enabled: patch.teamBroadcastEnabled as boolean }
          : {})
      };
    }) as never,
    ...overrides
  };
}

describe("manageEmployee, add", () => {
  it("adds a teammate and asks the model to read the number back", async () => {
    const d = deps([]);
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "Sandy Reyes", phone: "602-555-0134" },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.employee.phoneE164).toBe("+16025550134");
    expect(res.employee.leadRotation).toBe(true);
    expect(res.note).toContain("read the number back");
    expect(d.createMember).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ name: "Sandy Reyes", phoneE164: "+16025550134" })
    );
  });

  it("carries the availability flags through the add", async () => {
    const d = deps([]);
    const res = await manageEmployee(
      BIZ,
      {
        action: "add",
        name: "Sandy Reyes",
        phone: "+16025550134",
        leadRotation: false,
        namedLeads: true,
        namedGroupOffers: true,
        wholeTeamOffers: false
      },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.employee).toMatchObject({
      leadRotation: false,
      namedLeads: true,
      namedGroupOffers: true,
      wholeTeamOffers: false
    });
    expect(res.note).toContain("leads in rotation");
    expect(res.note).toContain("whole-team offers");
  });

  it("parses working hours given at add time", async () => {
    const d = deps([]);
    const res = await manageEmployee(
      BIZ,
      {
        action: "add",
        name: "Sandy Reyes",
        phone: "+16025550134",
        scheduleText: "mon-fri 09:00-17:00",
        preferredText: "mon 09:00-12:00"
      },
      d
    );
    expect(res.ok).toBe(true);
    expect(d.createMember).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        weeklySchedule: expect.objectContaining({ mon: [["09:00", "17:00"]] }),
        preferredWindows: { mon: [["09:00", "12:00"]] }
      })
    );
  });

  it("refuses a garbled schedule at add time instead of benching the new hire", async () => {
    const d = deps([]);
    for (const [field, args] of [
      ["invalid_schedule", { scheduleText: "mon 9am-5pm" }],
      ["invalid_preferred_times", { preferredText: "whenever" }]
    ] as const) {
      const res = await manageEmployee(
        BIZ,
        { action: "add", name: "Sandy", phone: "+16025550134", ...args },
        d
      );
      expect(res).toMatchObject({ ok: false });
      if (res.ok) continue;
      expect(res.message).toContain(field);
    }
    expect(d.createMember).not.toHaveBeenCalled();
  });

  it("stores an email given at add time", async () => {
    const d = deps([]);
    await manageEmployee(
      BIZ,
      { action: "add", name: "Sandy", phone: "+16025550134", email: "sandy@example.com" },
      d
    );
    expect(d.createMember).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: "sandy@example.com" })
    );
  });

  it("takes the new teammate's name from `employee` when the model puts it there", async () => {
    const d = deps([]);
    const res = await manageEmployee(
      BIZ,
      { action: "add", employee: "Sandy Reyes", phone: "+16025550134" },
      d
    );
    expect(res.ok).toBe(true);
    expect(d.createMember).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ name: "Sandy Reyes" })
    );
  });

  it("refuses a name-only add rather than inventing a number", async () => {
    const res = await manageEmployee(BIZ, { action: "add", name: "Sandy" }, deps([]));
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("missing_phone");
  });

  it("refuses a number-only add rather than inventing a name", async () => {
    const res = await manageEmployee(BIZ, { action: "add", phone: "+16025550134" }, deps([]));
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("missing_name");
  });

  it("refuses an unusable number", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "Sandy", phone: "12345" },
      deps([])
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("invalid_phone");
  });

  it("refuses a malformed email at add time", async () => {
    const d = deps([]);
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "Sandy", phone: "+16025550134", email: "sandy@@example" },
      d
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("invalid_email");
    expect(d.createMember).not.toHaveBeenCalled();
  });

  it("points a duplicate number at the person who already holds it", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "Dave L", phone: "+16025245719" },
      deps([DAVE])
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("already_on_roster");
    expect(res.message).toContain("Dave Lane");
  });

  it("suggests reactivating rather than duplicating an inactive teammate", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "Dave Lane", phone: "+16025245719" },
      deps([member({ ...DAVE, active: false })])
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("Reactivate them");
  });

  it("reports a losing insert race as the duplicate it is", async () => {
    const d = deps([], {
      createMember: vi.fn(async () => {
        throw new Error(
          'createTeamMember: duplicate key value violates unique constraint "ai_flow_team_members_business_phone_key"'
        );
      })
    });
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "Sandy", phone: "+16025550134" },
      d
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("already_on_roster");
  });

  it("never reports a failed insert as success, even on a non-Error throw", async () => {
    const d = deps([], {
      createMember: vi.fn(async () => {
        throw "connection reset";
      })
    });
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "Sandy", phone: "+16025550134" },
      d
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("add_failed");
    expect(res.message).toContain("Nothing was changed");
  });
});

describe("manageEmployee, finding the right person", () => {
  const roster = [member(), DAVE];

  it("matches an exact name, a first name, and a phone", async () => {
    for (const employee of ["Gabrielle Mota", "gabrielle", "+14807202013", "480-720-2013"]) {
      const res = await manageEmployee(
        BIZ,
        { action: "update", employee, leadRotation: false },
        deps(roster)
      );
      expect(res.ok, `resolving "${employee}"`).toBe(true);
      if (!res.ok) continue;
      expect(res.employee.name).toBe("Gabrielle Mota");
    }
  });

  it("asks which one instead of guessing between two identical full names", async () => {
    const twin = member({
      id: "aaaaaaaa-0000-4000-8000-000000000004",
      name: "Dave Lane",
      phone_e164: "+16025550188"
    });
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Dave Lane", leadRotation: false },
      deps([DAVE, twin])
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("ambiguous_employee");
    expect(res.message).toContain("+16025550188");
  });

  it("asks which one instead of guessing between two Daves", async () => {
    const otherDave = member({
      id: "aaaaaaaa-0000-4000-8000-000000000003",
      name: "Dave Chen",
      phone_e164: "+16025550199"
    });
    const res = await manageEmployee(
      BIZ,
      { action: "deactivate", employee: "Dave" },
      deps([DAVE, otherDave])
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("ambiguous_employee");
    expect(res.message).toContain("+16025245719");
    expect(res.message).toContain("+16025550199");
  });

  it("lists the roster when the name matches nobody", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Priya", leadRotation: false },
      deps(roster)
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("not_on_roster");
    expect(res.message).toContain("Gabrielle Mota, Dave Lane");
  });

  it("does not fall back to name matching for an off-roster number", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "+16025559999", leadRotation: false },
      deps(roster)
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("not_on_roster");
    expect(res.message).toContain("+16025559999");
  });
});

describe("manageEmployee, update and deactivate", () => {
  const roster = [member(), DAVE];

  it("turns one flag off and leaves the others alone", async () => {
    const d = deps(roster);
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Gabrielle Mota", leadRotation: false },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(d.updateMember).toHaveBeenCalledWith(BIZ, roster[0].id, { routingEnabled: false });
    expect(res.employee).toMatchObject({
      leadRotation: false,
      namedLeads: true,
      namedGroupOffers: true,
      wholeTeamOffers: true
    });
    expect(res.note).toContain("They no longer receive: leads in rotation.");
  });

  it("turns off only being asked for by name, leaving the rotation on", async () => {
    const d = deps(roster);
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Dave Lane", namedLeads: false },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(d.updateMember).toHaveBeenCalledWith(BIZ, DAVE.id, { namedRoutingEnabled: false });
    expect(res.employee).toMatchObject({ leadRotation: true, namedLeads: false });
    expect(res.note).toContain("They no longer receive: leads named to them.");
  });

  it("tells the owner their own alerts are untouched", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Dave Lane", leadRotation: false },
      deps(roster)
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.note).toContain("Owner alerts are unaffected");
  });

  it("says plainly when all four switches are off", async () => {
    const res = await manageEmployee(
      BIZ,
      {
        action: "update",
        employee: "Dave Lane",
        leadRotation: false,
        namedLeads: false,
        namedGroupOffers: false,
        wholeTeamOffers: false
      },
      deps(roster)
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.note).toContain("no lead offers of any kind");
  });

  it("says so when every way in is open", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Dave Lane", leadRotation: true },
      deps(roster)
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.note).toContain("They receive leads every way");
    expect(res.note).toContain("leads named to them");
  });

  it("deactivates, and says that outranks the switches", async () => {
    const d = deps(roster);
    const res = await manageEmployee(BIZ, { action: "deactivate", employee: "Dave Lane" }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(d.updateMember).toHaveBeenCalledWith(BIZ, DAVE.id, { active: false });
    expect(res.employee.active).toBe(false);
    expect(res.note).toContain("no leads at all until reactivated");
  });

  it("applies field edits alongside a reactivate in one write", async () => {
    const d = deps([member({ ...DAVE, active: false })]);
    const res = await manageEmployee(
      BIZ,
      { action: "reactivate", employee: "Dave Lane", phone: "+16025550177" },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(d.updateMember).toHaveBeenCalledWith(BIZ, DAVE.id, {
      active: true,
      phoneE164: "+16025550177"
    });
  });

  it("renames someone, trimming and capping the new name", async () => {
    const d = deps(roster);
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "+16025245719", name: "  Dave Lane Jr.  " },
      d
    );
    expect(res.ok).toBe(true);
    expect(d.updateMember).toHaveBeenCalledWith(BIZ, DAVE.id, { name: "Dave Lane Jr." });
  });

  it("refuses an unusable new number", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Dave Lane", phone: "12345" },
      deps(roster)
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("invalid_phone");
  });

  it("refuses a number that already belongs to someone else", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Gabrielle Mota", phone: "+16025245719" },
      deps(roster)
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("phone_taken");
    expect(res.message).toContain("Dave Lane");
  });

  it("refuses garbled hours instead of silently benching them", async () => {
    for (const [field, args] of [
      ["invalid_schedule", { scheduleText: "mon 9am-5pm" }],
      ["invalid_preferred_times", { preferredText: "afternoons" }]
    ] as const) {
      const res = await manageEmployee(
        BIZ,
        { action: "update", employee: "Dave Lane", ...args },
        deps(roster)
      );
      expect(res).toMatchObject({ ok: false });
      if (res.ok) continue;
      expect(res.message).toContain(field);
    }
  });

  it("refuses a malformed email", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Dave Lane", email: "dave@@example" },
      deps(roster)
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("invalid_email");
  });

  it("clears the email on an empty string, and parses a valid schedule", async () => {
    const d = deps(roster);
    const res = await manageEmployee(
      BIZ,
      {
        action: "update",
        employee: "Dave Lane",
        email: "",
        scheduleText: "mon-fri 09:00-17:00",
        preferredText: ""
      },
      d
    );
    expect(res.ok).toBe(true);
    expect(d.updateMember).toHaveBeenCalledWith(
      BIZ,
      DAVE.id,
      expect.objectContaining({ email: null, weeklySchedule: expect.any(Object) })
    );
  });

  it("refuses an empty new name", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Dave Lane", name: "   " },
      deps(roster)
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("invalid_name");
  });

  it("asks what to change when the call carries no edits", async () => {
    const res = await manageEmployee(BIZ, { action: "update", employee: "Dave Lane" }, deps(roster));
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("nothing_to_change");
  });

  it("reports a lost row rather than claiming the edit landed", async () => {
    const d = deps(roster, { updateMember: vi.fn(async () => null) });
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Dave Lane", leadRotation: false },
      d
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("not_on_roster");
  });

  it("never reports a failed update as success, whatever the write threw", async () => {
    for (const thrown of [new Error("updateTeamMember: rls"), "connection reset"]) {
      const d = deps(roster, {
        updateMember: vi.fn(async () => {
          throw thrown;
        })
      });
      const res = await manageEmployee(
        BIZ,
        { action: "update", employee: "Dave Lane", leadRotation: false },
        d
      );
      expect(res).toMatchObject({ ok: false });
      if (res.ok) continue;
      expect(res.message).toContain("update_failed");
      expect(res.message).toContain("Nothing was changed");
    }
  });
});

describe("manageEmployee, roster read", () => {
  it("changes nothing when the roster cannot be read", async () => {
    for (const thrown of [new Error("listTeamMembers: rls"), "boom"]) {
      const d = deps([], {
        listMembers: vi.fn(async () => {
          throw thrown;
        })
      });
      const res = await manageEmployee(BIZ, { action: "add", name: "S", phone: "+16025550134" }, d);
      expect(res).toMatchObject({ ok: false });
      if (res.ok) continue;
      expect(res.message).toContain("roster_read_failed");
      expect(d.createMember).not.toHaveBeenCalled();
    }
  });

  it("names the empty roster instead of a bare no-match", async () => {
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Anyone", leadRotation: false },
      deps([])
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("The roster is empty.");
  });

  it("asks who to change when no identifier is given", async () => {
    const res = await manageEmployee(BIZ, { action: "deactivate" }, deps([DAVE]));
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.message).toContain("missing_employee");
  });

  it("reads a pre-migration row (null flags) as fully available", async () => {
    const legacy = member({
      routing_enabled: null as unknown as boolean,
      named_broadcast_enabled: null as unknown as boolean,
      team_broadcast_enabled: null as unknown as boolean
    });
    const d = deps([legacy], {
      updateMember: vi.fn(async () => ({ ...legacy, email: "g@example.com" }))
    });
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Gabrielle Mota", email: "g@example.com" },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.employee).toMatchObject({
      leadRotation: true,
      namedGroupOffers: true,
      wholeTeamOffers: true
    });
  });
});

describe("manageEmployee, international numbers", () => {
  // Long codes deliver SMS to +1 only, so a non-NANP roster number means
  // every lead offer and team alert text silently dies at Telnyx. The note
  // must say so and recommend WhatsApp (KYP Ads, Jul 30 2026: the owner
  // moved his own roster entry to a Hong Kong +852 line and was told
  // notifications would "now be routed" there).
  it("warns and recommends WhatsApp when adding a teammate at a non-NANP number", async () => {
    const d = deps([]);
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "James Lee", phone: "+85260100607" },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.employee.phoneE164).toBe("+85260100607");
    expect(res.note).toContain("will never arrive");
    expect(res.note).toContain("WhatsApp");
    expect(res.note).toContain("/dashboard/integrations/whatsapp");
  });

  it("warns when an update moves an existing teammate onto a non-NANP number", async () => {
    const d = deps([member()]);
    const res = await manageEmployee(
      BIZ,
      { action: "update", employee: "Gabrielle Mota", phone: "+85260100607" },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.employee.phoneE164).toBe("+85260100607");
    expect(res.note).toContain("will never arrive");
    expect(res.note).toContain("WhatsApp");
  });

  it("keeps re-surfacing the warning on any later change to that teammate", async () => {
    // The gap does not heal with time: a reactivation months later still
    // routes their lead offers at an untextable number.
    const hk = member({ phone_e164: "+85260100607", active: false });
    const d = deps([hk]);
    const res = await manageEmployee(BIZ, { action: "reactivate", employee: "Gabrielle Mota" }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.note).toContain("WhatsApp");
  });

  it("stays quiet for NANP numbers, Canada included", async () => {
    const d = deps([]);
    const res = await manageEmployee(
      BIZ,
      { action: "add", name: "Sandy Reyes", phone: "+15145188192" },
      d
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.note).not.toContain("WhatsApp");
  });
});
