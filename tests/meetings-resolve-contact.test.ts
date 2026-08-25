import { beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServiceClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...args: unknown[]) => createSupabaseServiceClient(...args)
}));

import {
  contactKeyFromAttendeeKey,
  findContactIdByUniqueName,
  extractTranscriptEmails,
  resolveMeetingContact
} from "@/lib/meetings/resolve-contact";

/**
 * Attribution. Everything the classifier decides lands on a PERSON, so a
 * wrong answer here staples a stranger's meeting notes, stage move and
 * to-dos onto someone's record. These tests are mostly about the cases where
 * the right answer is "nobody".
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const KINGSLEY_KEY = "+17807076365";
const KINGSLEY_ID = "c-kingsley";

const VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:01.000 --> 00:00:04.000",
  "Brian Lane: Thanks for making the time today.",
  "",
  "2",
  "00:00:05.000 --> 00:00:09.000",
  "Kingsley Moyo: Happy to be here. Send it to king@kinintegrated.com.",
  ""
].join("\n");

const contactRow = (over: Record<string, unknown> = {}) => ({
  id: KINGSLEY_ID,
  customer_e164: KINGSLEY_KEY,
  ...over
});

function deps(over: Record<string, unknown> = {}) {
  return {
    findBooking: vi.fn(async () => null),
    getContact: vi.fn(async () => null),
    findByEmail: vi.fn(async () => null),
    findByName: vi.fn(async () => null),
    ...over
  } as never;
}

const input = {
  businessId: BIZ,
  zoomMeetingId: "89815540862",
  vtt: VTT,
  hostNames: ["New Coworker", "Brian Lane"]
};

beforeEach(() => {
  createSupabaseServiceClient.mockReset();
});

describe("extractTranscriptEmails", () => {
  it("finds an address spoken mid-sentence, without its trailing punctuation", () => {
    expect(extractTranscriptEmails("Send it to king@kinintegrated.com.")).toEqual([
      "king@kinintegrated.com"
    ]);
  });

  it("lowercases and de-dupes", () => {
    expect(
      extractTranscriptEmails("King@Example.com and again king@example.com")
    ).toEqual(["king@example.com"]);
  });

  it("refuses anything the contact-key gate would refuse", () => {
    // The same validator that decides whether an address can BE a key, so a
    // regex hit that could never become a contact never becomes a lookup.
    expect(extractTranscriptEmails("write to bob@localhost or @nowhere")).toEqual([]);
  });

  it("returns nothing for text with no addresses", () => {
    expect(extractTranscriptEmails("no addresses at all here")).toEqual([]);
  });
});

describe("contactKeyFromAttendeeKey", () => {
  it("strips the phone prefix, because contacts store the bare number", () => {
    // The bug this function exists to prevent: contacts.customer_e164 holds
    // "+17807076365", never "phone:+17807076365", so passing the ledger key
    // through unchanged resolves nobody, silently.
    expect(contactKeyFromAttendeeKey("phone:+17807076365")).toBe("+17807076365");
  });

  it("keeps the email prefix, because contacts DO store that one", () => {
    expect(contactKeyFromAttendeeKey("email:king@kinintegrated.com")).toBe(
      "email:king@kinintegrated.com"
    );
  });

  it("normalizes an email key's casing on the way through", () => {
    expect(contactKeyFromAttendeeKey("email:King@KinIntegrated.com")).toBe(
      "email:king@kinintegrated.com"
    );
  });

  it("refuses the keys that name nobody", () => {
    expect(contactKeyFromAttendeeKey("name:kingsley moyo")).toBeNull();
    expect(contactKeyFromAttendeeKey("anonymous")).toBeNull();
    expect(contactKeyFromAttendeeKey("phone:")).toBeNull();
    expect(contactKeyFromAttendeeKey("email:not-an-address")).toBeNull();
  });
});

describe("resolveMeetingContact: the booking ledger", () => {
  it("resolves the attendee the booking recorded", async () => {
    // The fake answers ONLY for the bare number, which is what
    // contacts.customer_e164 actually holds. A fake that accepted the
    // ledger's own `phone:+1...` key would pass while production resolved
    // nobody.
    const getContact = vi.fn(async (_b: string, key: string) =>
      key === KINGSLEY_KEY ? contactRow() : null
    );
    const out = await resolveMeetingContact(
      input,
      deps({
        findBooking: vi.fn(async () => ({
          attendeeKey: `phone:${KINGSLEY_KEY}`,
          attendeeEmail: "king@kinintegrated.com",
          attendeeName: "Kingsley Moyo",
          startAt: "2026-08-20T19:59:09Z"
        })),
        getContact
      })
    );
    expect(out).toEqual({
      contactId: KINGSLEY_ID,
      contactKey: KINGSLEY_KEY,
      matchedOn: "booking_ledger"
    });
    expect(getContact).toHaveBeenCalledWith(BIZ, KINGSLEY_KEY);
  });

  it("falls back to the booking's email when the key resolves nothing", async () => {
    const d = deps({
      findBooking: vi.fn(async () => ({
        attendeeKey: "phone:+15550000000",
        attendeeEmail: "king@kinintegrated.com",
        attendeeName: null,
        startAt: "2026-08-20T19:59:09Z"
      })),
      getContact: vi.fn(async (_b: string, key: string) =>
        key === "email:king@kinintegrated.com" ? contactRow({ customer_e164: "email:king@kinintegrated.com" }) : null
      )
    });
    const out = await resolveMeetingContact(input, d);
    expect(out).toMatchObject({
      contactKey: "email:king@kinintegrated.com",
      matchedOn: "booking_ledger"
    });
  });

  it("does not treat a name: ledger key as an identity", async () => {
    // bookingAttendeeKey falls back to `name:` when there is no phone and no
    // email. A name is not an identity, so it must go through the unique
    // name rule like any other name, not straight to a lookup.
    const getContact = vi.fn(async () => contactRow());
    const d = deps({
      findBooking: vi.fn(async () => ({
        attendeeKey: "name:kingsley moyo",
        attendeeEmail: null,
        attendeeName: "Kingsley Moyo",
        startAt: "2026-08-20T19:59:09Z"
      })),
      getContact
    });
    await resolveMeetingContact(input, d);
    expect(getContact).not.toHaveBeenCalledWith(BIZ, "name:kingsley moyo");
  });

  it("skips the ledger entirely without a meeting id", async () => {
    const findBooking = vi.fn(async () => null);
    await resolveMeetingContact({ ...input, zoomMeetingId: null }, deps({ findBooking }));
    expect(findBooking).not.toHaveBeenCalled();
  });
});

describe("resolveMeetingContact: the transcript fallbacks", () => {
  it("matches an address spoken on the call, as a contact key", async () => {
    const d = deps({
      getContact: vi.fn(async (_b: string, key: string) =>
        key === "email:king@kinintegrated.com"
          ? contactRow({ customer_e164: "email:king@kinintegrated.com" })
          : null
      )
    });
    const out = await resolveMeetingContact({ ...input, zoomMeetingId: null }, d);
    expect(out).toMatchObject({ matchedOn: "transcript_email" });
  });

  it("matches an address LINKED to a phone-keyed profile", async () => {
    const d = deps({
      getContact: vi.fn(async (_b: string, key: string) =>
        key === KINGSLEY_KEY ? contactRow() : null
      ),
      findByEmail: vi.fn(async () => ({
        customerE164: KINGSLEY_KEY,
        displayName: "Kingsley Moyo"
      }))
    });
    const out = await resolveMeetingContact({ ...input, zoomMeetingId: null }, d);
    expect(out).toEqual({
      contactId: KINGSLEY_ID,
      contactKey: KINGSLEY_KEY,
      matchedOn: "transcript_email"
    });
  });

  it("survives a throwing email lookup", async () => {
    const d = deps({
      findByEmail: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    expect(await resolveMeetingContact({ ...input, zoomMeetingId: null }, d)).toBeNull();
  });

  it("looks up the guest's WHOLE speaker name, not a first name", async () => {
    // Bugbot, PR #1566: this used pickZoomGuestName, which is built for
    // TITLES and shortens to a first name or a nickname. Contacts store full
    // names, so an anchored "Kingsley" could never match "Kingsley Moyo" and
    // the entire name fallback was dead for the common case.
    const findByName = vi.fn(async () => null);
    await resolveMeetingContact({ ...input, zoomMeetingId: null }, deps({ findByName }));
    expect(findByName).toHaveBeenCalledWith(BIZ, "Kingsley Moyo");
  });

  it("falls through to the guest's speaker name", async () => {
    createSupabaseServiceClient.mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { customer_e164: KINGSLEY_KEY } }) })
          })
        })
      })
    } as never);
    const d = deps({ findByName: vi.fn(async () => KINGSLEY_ID) });
    const out = await resolveMeetingContact({ ...input, zoomMeetingId: null }, d);
    expect(out).toEqual({
      contactId: KINGSLEY_ID,
      contactKey: KINGSLEY_KEY,
      matchedOn: "speaker_name"
    });
  });

  it("never matches our own side by name", async () => {
    const findByName = vi.fn(async () => KINGSLEY_ID);
    // Both speakers are hosts, so there is no guest to name.
    await resolveMeetingContact(
      { ...input, zoomMeetingId: null, hostNames: ["Brian Lane", "Kingsley Moyo"] },
      deps({ findByName })
    );
    expect(findByName).not.toHaveBeenCalled();
  });

  it("answers nobody when the name lookup is ambiguous", async () => {
    // findByName returns null for "two contacts share this name", which is
    // the rule that keeps a coin flip from filing notes on a stranger.
    const out = await resolveMeetingContact(
      { ...input, zoomMeetingId: null },
      deps({ findByName: vi.fn(async () => null) })
    );
    expect(out).toBeNull();
  });

  it("answers nobody when the named contact has no key to act on", async () => {
    createSupabaseServiceClient.mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) })
        })
      })
    } as never);
    const out = await resolveMeetingContact(
      { ...input, zoomMeetingId: null },
      deps({ findByName: vi.fn(async () => KINGSLEY_ID) })
    );
    expect(out).toBeNull();
  });

  it("survives a throwing key lookup", async () => {
    const d = deps({
      getContact: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    expect(await resolveMeetingContact({ ...input, zoomMeetingId: null }, d)).toBeNull();
  });

  it("ignores a contact row with no id", async () => {
    const d = deps({
      getContact: vi.fn(async () => ({ id: "", customer_e164: KINGSLEY_KEY }))
    });
    expect(await resolveMeetingContact({ ...input, zoomMeetingId: null }, d)).toBeNull();
  });
});

describe("findContactIdByUniqueName", () => {
  /** Records the filter calls so the query shape itself can be asserted. */
  function nameClient(rows: unknown, error: unknown = null) {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "ilike", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ name: m, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error }).then(resolve);
    createSupabaseServiceClient.mockResolvedValue({ from: () => builder } as never);
    return calls;
  }

  it("returns the id when exactly one contact carries the name", async () => {
    const calls = nameClient([{ id: KINGSLEY_ID, display_name: "Kingsley Moyo" }]);
    expect(await findContactIdByUniqueName(BIZ, "Kingsley Moyo")).toBe(KINGSLEY_ID);
    // Anchored ilike: equality that ignores casing, with NO wildcards, so
    // "Dave" can never match "Dave's Plumbing".
    const ilike = calls.find((c) => c.name === "ilike");
    expect(ilike?.args).toEqual(["display_name", "Kingsley Moyo"]);
    // Two rows are enough to know the name is ambiguous.
    expect(calls.find((c) => c.name === "limit")?.args).toEqual([2]);
  });

  it("escapes LIKE metacharacters in the speaker label", async () => {
    // Bugbot, PR #1566: `_` is a single-character wildcard in LIKE, so an
    // unescaped Zoom label "dave_smith" also matched "daveXsmith" and would
    // file this meeting's note, stage move and to-dos on a different person.
    const calls = nameClient([{ id: "c-1", display_name: "dave_smith" }]);
    await findContactIdByUniqueName(BIZ, "dave_smith");
    expect(calls.find((c) => c.name === "ilike")?.args).toEqual([
      "display_name",
      "dave\\_smith"
    ]);
  });

  it("re-verifies the match in JS, so a wildcard can never slip through", async () => {
    // Belt and braces, the same shape findCustomerByEmail uses: even if a
    // pattern did widen, a row whose name is not the label is refused.
    nameClient([{ id: "c-1", display_name: "daveXsmith" }]);
    expect(await findContactIdByUniqueName(BIZ, "dave_smith")).toBeNull();
  });

  it("matches case-insensitively on the re-verify", async () => {
    nameClient([{ id: KINGSLEY_ID, display_name: "  KINGSLEY MOYO " }]);
    expect(await findContactIdByUniqueName(BIZ, "Kingsley Moyo")).toBe(KINGSLEY_ID);
  });

  it("refuses a row whose display name is null", async () => {
    nameClient([{ id: "c-1", display_name: null }]);
    expect(await findContactIdByUniqueName(BIZ, "Kingsley Moyo")).toBeNull();
  });

  it("refuses an ambiguous name rather than picking one", async () => {
    nameClient([
      { id: "c-1", display_name: "Dave" },
      { id: "c-2", display_name: "Dave" }
    ]);
    expect(await findContactIdByUniqueName(BIZ, "Dave")).toBeNull();
  });

  it("returns null for no match, a blank name, an error, or missing data", async () => {
    nameClient([]);
    expect(await findContactIdByUniqueName(BIZ, "Nobody")).toBeNull();

    expect(await findContactIdByUniqueName(BIZ, "   ")).toBeNull();

    nameClient(null, { message: "boom" });
    expect(await findContactIdByUniqueName(BIZ, "Kingsley Moyo")).toBeNull();

    nameClient(null);
    expect(await findContactIdByUniqueName(BIZ, "Kingsley Moyo")).toBeNull();
  });

  it("survives a client blow-up", async () => {
    createSupabaseServiceClient.mockRejectedValue(new Error("no env"));
    expect(await findContactIdByUniqueName(BIZ, "Kingsley Moyo")).toBeNull();

    createSupabaseServiceClient.mockRejectedValue("raw string");
    expect(await findContactIdByUniqueName(BIZ, "Kingsley Moyo")).toBeNull();
  });
});

describe("resolveMeetingContact: the name path's key lookup", () => {
  it("answers nobody when the key read blows up", async () => {
    createSupabaseServiceClient.mockRejectedValue(new Error("no env"));
    const out = await resolveMeetingContact(
      { ...input, zoomMeetingId: null },
      deps({ findByName: vi.fn(async () => KINGSLEY_ID) })
    );
    expect(out).toBeNull();
  });
});

describe("resolveMeetingContact: the remaining refusals", () => {
  it("drops a transcript address the contact-key gate will not accept", async () => {
    // Shaped like an address (the scan regex matches) but over the 254-char
    // ceiling emailContactKey enforces, so it can never BE a contact key.
    const huge = `${"a".repeat(250)}@example.com`;
    const getContact = vi.fn(async () => null);
    await resolveMeetingContact(
      { ...input, zoomMeetingId: null, vtt: `WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nGuest: mail me at ${huge}\n` },
      deps({ getContact })
    );
    expect(getContact).not.toHaveBeenCalled();
  });

  it("moves on when the meeting id matches no booking", async () => {
    const findBooking = vi.fn(async () => null);
    const out = await resolveMeetingContact(input, deps({ findBooking }));
    expect(findBooking).toHaveBeenCalledWith(BIZ, "89815540862");
    expect(out).toBeNull();
  });

  it("moves on from a booking that carries neither a usable key nor an email", async () => {
    const out = await resolveMeetingContact(
      input,
      deps({
        findBooking: vi.fn(async () => ({
          attendeeKey: "name:kingsley moyo",
          attendeeEmail: null,
          attendeeName: "Kingsley Moyo",
          startAt: "2026-08-20T19:59:09Z"
        }))
      })
    );
    expect(out).toBeNull();
  });

  it("ignores a booking email the contact-key gate refuses", async () => {
    // The booking ledger's email column is not gated the way a contact key
    // is, so a malformed value must be refused here rather than queried.
    const findByEmail = vi.fn(async () => null);
    await resolveMeetingContact(
      input,
      deps({
        findBooking: vi.fn(async () => ({
          attendeeKey: "name:nobody",
          attendeeEmail: "not an address",
          attendeeName: null,
          startAt: "2026-08-20T19:59:09Z"
        })),
        findByEmail
      })
    );
    expect(findByEmail).toHaveBeenCalledWith(BIZ, "not an address");
  });

  it("survives raw thrown values from either lookup", async () => {
    const rawThrow = async () => {
      throw "raw string";
    };
    expect(
      await resolveMeetingContact(
        { ...input, zoomMeetingId: null },
        deps({ getContact: rawThrow })
      )
    ).toBeNull();
    expect(
      await resolveMeetingContact(
        { ...input, zoomMeetingId: null },
        deps({ findByEmail: rawThrow })
      )
    ).toBeNull();
  });

  it("answers nobody when the named contact's key column is null", async () => {
    createSupabaseServiceClient.mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { customer_e164: null } }) })
          })
        })
      })
    } as never);
    const out = await resolveMeetingContact(
      { ...input, zoomMeetingId: null },
      deps({ findByName: vi.fn(async () => KINGSLEY_ID) })
    );
    expect(out).toBeNull();
  });
});

describe("resolveMeetingContact: a name the HOST used", () => {
  /**
   * The wrong-Zoom-account case. The guest speaks under somebody else's
   * display name, so the speaker-label source finds nobody, but our own
   * side called them by their real name on the call.
   */
  const WRONG_ACCOUNT_VTT = [
    "WEBVTT",
    "",
    "1",
    "00:00:01.000 --> 00:00:04.000",
    "Brian Lane: Hey, Bobby.",
    "",
    "2",
    "00:00:05.000 --> 00:00:09.000",
    "Alexander: Oh, good. Hi, morning.",
    ""
  ].join("\n");

  const wrongAccountInput = {
    businessId: BIZ,
    zoomMeetingId: null,
    vtt: WRONG_ACCOUNT_VTT,
    hostNames: ["New Coworker", "Brian Lane"]
  };

  /** The key lookup behind a name match reads `contacts` directly. */
  function keyClient(customerE164: string | null) {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) builder[m] = () => builder;
    builder.maybeSingle = async () => ({
      data: customerE164 === null ? null : { customer_e164: customerE164 },
      error: null
    });
    createSupabaseServiceClient.mockResolvedValue({ from: () => builder } as never);
  }

  it("finds the contact the host addressed when the speaker label matches nobody", async () => {
    keyClient("+17208438676");
    const d = deps({
      findByName: vi.fn(async (_biz: string, name: string) =>
        name === "Bobby" ? "c-bobby" : null
      )
    });
    expect(await resolveMeetingContact(wrongAccountInput, d)).toEqual({
      contactId: "c-bobby",
      contactKey: "+17208438676",
      matchedOn: "addressed_name"
    });
  });

  it("tries the speaker label FIRST, so a correct label is never second-guessed", async () => {
    keyClient(KINGSLEY_KEY);
    const d = deps({ findByName: vi.fn(async () => KINGSLEY_ID) });
    const result = await resolveMeetingContact(wrongAccountInput, d);
    expect(result?.matchedOn).toBe("speaker_name");
  });

  it("answers nobody when the addressed name matches no contact", async () => {
    const d = deps({ findByName: vi.fn(async () => null) });
    expect(await resolveMeetingContact(wrongAccountInput, d)).toBeNull();
  });

  it("answers nobody when the addressed contact has no usable key", async () => {
    keyClient(null);
    const d = deps({
      findByName: vi.fn(async (_biz: string, name: string) =>
        name === "Bobby" ? "c-bobby" : null
      )
    });
    expect(await resolveMeetingContact(wrongAccountInput, d)).toBeNull();
  });
});
