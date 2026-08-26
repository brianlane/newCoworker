import { describe, it, expect } from "vitest";
import {
  BOX_LAPSE_WARNING_DAYS,
  BOX_SNAPSHOT_STALE_MS,
  boxRunwayLabel,
  boxSnapshotStale,
  boxTermDaysLeft,
  boxTermEndsAt,
  boxTermState,
  pickLiveBoxSnapshot,
  summarizeBoxTerm
} from "@/lib/vps/box-term";

const NOW = new Date("2026-08-26T12:00:00Z");

function row(over: Partial<Parameters<typeof summarizeBoxTerm>[0]> = {}) {
  return {
    status: "active",
    is_auto_renewed: true,
    next_billing_at: null,
    expires_at: null,
    ...over
  };
}

describe("boxTermState", () => {
  it("reads a live auto-renewing subscription as renewing", () => {
    expect(boxTermState({ status: "active", is_auto_renewed: true })).toBe("renewing");
  });

  it("reads cancelled from the status even when auto-renew still says true", () => {
    // Status wins: a cancelled subscription cannot renew whatever the flag says.
    expect(boxTermState({ status: "cancelled", is_auto_renewed: true })).toBe("cancelled");
  });

  it("reads is_auto_renewed false as lapsing", () => {
    expect(boxTermState({ status: "active", is_auto_renewed: false })).toBe("lapsing");
  });

  it("reads the non_renewing status as lapsing", () => {
    expect(boxTermState({ status: "non_renewing", is_auto_renewed: null })).toBe("lapsing");
  });

  it("treats an unknown auto-renew flag as renewing, never as dying", () => {
    // Null is "not synced", and painting every unsynced box as lapsing would
    // make the warning worthless.
    expect(boxTermState({ status: "active", is_auto_renewed: null })).toBe("renewing");
  });
});

describe("boxTermEndsAt", () => {
  it("uses next_billing_at for a renewing box", () => {
    expect(
      boxTermEndsAt(row({ next_billing_at: "2027-09-05T04:23:54Z", expires_at: null }))
    ).toBe("2027-09-05T04:23:54Z");
  });

  it("uses expires_at for a cancelled box", () => {
    expect(
      boxTermEndsAt(
        row({
          status: "cancelled",
          is_auto_renewed: false,
          next_billing_at: null,
          expires_at: "2026-08-08T22:52:19Z"
        })
      )
    ).toBe("2026-08-08T22:52:19Z");
  });

  it("falls back to expires_at when a renewing row carries no next_billing_at", () => {
    expect(boxTermEndsAt(row({ next_billing_at: null, expires_at: "2026-12-01T00:00:00Z" }))).toBe(
      "2026-12-01T00:00:00Z"
    );
  });

  it("falls back to next_billing_at when a lapsing row carries no expires_at", () => {
    expect(
      boxTermEndsAt(
        row({ is_auto_renewed: false, next_billing_at: "2026-09-01T00:00:00Z", expires_at: null })
      )
    ).toBe("2026-09-01T00:00:00Z");
  });

  it("is null when Hostinger reported neither date", () => {
    expect(boxTermEndsAt(row())).toBeNull();
  });
});

describe("boxTermDaysLeft", () => {
  it("rounds a partial day up", () => {
    expect(boxTermDaysLeft("2026-08-27T18:00:00Z", NOW)).toBe(2);
  });

  it("floors a date already in the past at zero rather than going negative", () => {
    expect(boxTermDaysLeft("2026-08-01T00:00:00Z", NOW)).toBe(0);
  });

  it("is null for a missing date", () => {
    expect(boxTermDaysLeft(null, NOW)).toBeNull();
    expect(boxTermDaysLeft(undefined, NOW)).toBeNull();
  });

  it("is null for an unparseable date rather than NaN days", () => {
    expect(boxTermDaysLeft("not-a-date", NOW)).toBeNull();
  });

  it("defaults now to the wall clock", () => {
    const far = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(boxTermDaysLeft(far)).toBe(10);
  });
});

describe("boxRunwayLabel", () => {
  it("is null when there are no days to describe", () => {
    expect(boxRunwayLabel(null)).toBeNull();
  });

  it("says ends today once the runway is gone", () => {
    expect(boxRunwayLabel(0)).toBe("ends today");
  });

  it("singularises one day", () => {
    expect(boxRunwayLabel(1)).toBe("1 day left");
  });

  it("gives exact days inside the two-month band", () => {
    expect(boxRunwayLabel(11)).toBe("11 days left");
    expect(boxRunwayLabel(59)).toBe("59 days left");
  });

  it("switches to months at the cutoff, skipping a degenerate one-month band", () => {
    expect(boxRunwayLabel(60)).toBe("about 2 months left");
  });

  it("describes a freshly bought year in months", () => {
    expect(boxRunwayLabel(375)).toBe("about 12 months left");
  });
});

describe("boxSnapshotStale", () => {
  it("accepts a snapshot from this morning's sync", () => {
    expect(boxSnapshotStale("2026-08-26T11:10:16Z", NOW)).toBe(false);
  });

  it("flags a snapshot older than a day plus slack", () => {
    const old = new Date(NOW.getTime() - BOX_SNAPSHOT_STALE_MS - 1000).toISOString();
    expect(boxSnapshotStale(old, NOW)).toBe(true);
  });

  it("treats a missing or unparseable stamp as stale, never as fresh", () => {
    expect(boxSnapshotStale(null, NOW)).toBe(true);
    expect(boxSnapshotStale(undefined, NOW)).toBe(true);
    expect(boxSnapshotStale("garbage", NOW)).toBe(true);
  });

  it("defaults now to the wall clock", () => {
    expect(boxSnapshotStale(new Date().toISOString())).toBe(false);
  });
});

describe("pickLiveBoxSnapshot", () => {
  it("is null for a VM with no snapshot rows", () => {
    expect(pickLiveBoxSnapshot([])).toBeNull();
  });

  it("prefers a lapsing subscription over a cancelled one with a longer leftover term", () => {
    // Liveness outranks the date. A lapsing subscription is still ours and
    // the billing-posture cron can re-enable it; a cancelled one is gone and
    // its remaining term is a leftover. Ranking them as equals let the
    // leftover's later date hide the live box.
    const cancelled = row({
      status: "cancelled",
      is_auto_renewed: false,
      expires_at: "2027-06-01T00:00:00Z"
    });
    const lapsing = row({
      status: "active",
      is_auto_renewed: false,
      expires_at: "2026-09-10T00:00:00Z"
    });
    expect(pickLiveBoxSnapshot([cancelled, lapsing])).toBe(lapsing);
    expect(pickLiveBoxSnapshot([lapsing, cancelled])).toBe(lapsing);
  });

  it("prefers the live subscription over a stale cancelled one for the same VM", () => {
    // The rebuilt-box case: the cancelled row's expiry describes hardware we
    // no longer pay for, and showing it would announce an outage that is not
    // coming. It loses even though its date is nearer.
    const cancelled = row({
      status: "cancelled",
      is_auto_renewed: false,
      expires_at: "2026-09-01T00:00:00Z"
    });
    const active = row({ next_billing_at: "2027-09-05T04:23:54Z" });
    expect(pickLiveBoxSnapshot([cancelled, active])).toBe(active);
    expect(pickLiveBoxSnapshot([active, cancelled])).toBe(active);
  });

  it("prefers the furthest end date among rows of the same posture", () => {
    const near = row({ next_billing_at: "2026-09-05T00:00:00Z" });
    const far = row({ next_billing_at: "2027-09-05T00:00:00Z" });
    expect(pickLiveBoxSnapshot([near, far])).toBe(far);
    expect(pickLiveBoxSnapshot([far, near])).toBe(far);
  });

  it("prefers a row that has a date over one that has none", () => {
    const dateless = row();
    const dated = row({ next_billing_at: "2026-09-05T00:00:00Z" });
    expect(pickLiveBoxSnapshot([dateless, dated])).toBe(dated);
  });

  it("still returns a row when every candidate is dateless", () => {
    const only = row({ status: "cancelled", is_auto_renewed: false });
    expect(pickLiveBoxSnapshot([only])).toBe(only);
  });

  it("ignores an unparseable date rather than ranking on NaN", () => {
    const junk = row({ next_billing_at: "not-a-date" });
    const good = row({ next_billing_at: "2026-09-05T00:00:00Z" });
    expect(pickLiveBoxSnapshot([junk, good])).toBe(good);
  });
});

describe("summarizeBoxTerm", () => {
  it("describes the HQ box after its one-year term change", () => {
    // Live shape observed Aug 26 2026 for VM 1806097: Hostinger pushed
    // next_billing_at a year out while still calling the period "1 month",
    // so the runway has to come from the date.
    const term = summarizeBoxTerm(
      row({ status: "active", is_auto_renewed: true, next_billing_at: "2027-09-05T04:23:54Z" }),
      NOW
    );
    expect(term.state).toBe("renewing");
    expect(term.endsAt).toBe("2027-09-05T04:23:54Z");
    expect(term.daysLeft).toBe(375);
    expect(term.runwayLabel).toBe("about 12 months left");
    expect(term.urgent).toBe(false);
  });

  it("flags a lapsing box inside the warning window", () => {
    const endsAt = new Date(
      NOW.getTime() + BOX_LAPSE_WARNING_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const term = summarizeBoxTerm(
      row({ status: "active", is_auto_renewed: false, expires_at: endsAt }),
      NOW
    );
    expect(term.state).toBe("lapsing");
    expect(term.daysLeft).toBe(BOX_LAPSE_WARNING_DAYS);
    expect(term.urgent).toBe(true);
  });

  it("does not flag a lapsing box that is still months out", () => {
    const term = summarizeBoxTerm(
      row({ status: "cancelled", is_auto_renewed: false, expires_at: "2027-01-01T00:00:00Z" }),
      NOW
    );
    expect(term.state).toBe("cancelled");
    expect(term.urgent).toBe(false);
  });

  it("never flags a renewing box, however close the charge is", () => {
    // A renewal landing tomorrow is business as usual, not an outage.
    const term = summarizeBoxTerm(row({ next_billing_at: "2026-08-27T00:00:00Z" }), NOW);
    expect(term.state).toBe("renewing");
    expect(term.daysLeft).toBe(1);
    expect(term.urgent).toBe(false);
  });

  it("keeps an unknown date distinct from an expired one", () => {
    const term = summarizeBoxTerm(row({ status: "cancelled", is_auto_renewed: false }), NOW);
    expect(term.endsAt).toBeNull();
    expect(term.daysLeft).toBeNull();
    expect(term.runwayLabel).toBeNull();
    expect(term.urgent).toBe(false);
  });

  it("defaults now to the wall clock", () => {
    const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(summarizeBoxTerm(row({ next_billing_at: far })).urgent).toBe(false);
  });
});
