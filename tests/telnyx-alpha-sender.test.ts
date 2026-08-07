import { describe, expect, it, vi } from "vitest";
import {
  ALPHA_NO_REPLY_LINE,
  alphaOwnerAlertProfile,
  intlAlphaProfileId,
  withAlphaNoReplyLine
} from "@/lib/telnyx/alpha-sender";
import {
  ALPHA_NO_REPLY_LINE as edgeNoReplyLine,
  alphaOwnerAlertProfile as edgeAlphaOwnerAlertProfile,
  intlAlphaProfileId as edgeIntlAlphaProfileId,
  withAlphaNoReplyLine as edgeWithAlphaNoReplyLine
} from "../supabase/functions/_shared/alpha_sender";

/**
 * Platform alpha-sender routing for international owner alerts: dormant
 * until TELNYX_INTL_ALPHA_PROFILE_ID is set post-registration, owner
 * alerts only, always carrying the no-reply line (an alpha sender has no
 * inbound path; silence about that is the RCS reply-loss failure mode).
 */

const ENV_SET = { TELNYX_INTL_ALPHA_PROFILE_ID: "40019fdc-dd03-4114-91f4-af8dc211cbd8" };

describe("intlAlphaProfileId", () => {
  it("returns the configured profile id and null when unset or blank", () => {
    expect(intlAlphaProfileId(ENV_SET)).toBe("40019fdc-dd03-4114-91f4-af8dc211cbd8");
    expect(intlAlphaProfileId({ TELNYX_INTL_ALPHA_PROFILE_ID: "  " })).toBeNull();
    expect(intlAlphaProfileId({})).toBeNull();
  });

  it("reads process.env when no env is injected (the runtime default)", () => {
    const prev = process.env.TELNYX_INTL_ALPHA_PROFILE_ID;
    try {
      process.env.TELNYX_INTL_ALPHA_PROFILE_ID = "prof-live";
      expect(intlAlphaProfileId()).toBe("prof-live");
      expect(edgeIntlAlphaProfileId()).toBe("prof-live");
      delete process.env.TELNYX_INTL_ALPHA_PROFILE_ID;
      expect(intlAlphaProfileId()).toBeNull();
      expect(edgeIntlAlphaProfileId()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.TELNYX_INTL_ALPHA_PROFILE_ID;
      else process.env.TELNYX_INTL_ALPHA_PROFILE_ID = prev;
    }
  });
});

describe("alphaOwnerAlertProfile", () => {
  it("routes only international destinations, and only when configured", () => {
    // Domestic owner phones keep the tenant's own number and two-way
    // thread even with the alpha profile configured.
    expect(alphaOwnerAlertProfile("US", ENV_SET)).toBeNull();
    expect(alphaOwnerAlertProfile("CA", ENV_SET)).toBeNull();
    // International destinations ride the alpha profile once configured.
    expect(alphaOwnerAlertProfile("HK", ENV_SET)).toBe("40019fdc-dd03-4114-91f4-af8dc211cbd8");
    expect(alphaOwnerAlertProfile("GB", ENV_SET)).toBe("40019fdc-dd03-4114-91f4-af8dc211cbd8");
    // Unresolvable country never classifies as domestic.
    expect(alphaOwnerAlertProfile(null, ENV_SET)).toBe("40019fdc-dd03-4114-91f4-af8dc211cbd8");
    // Env unset: dormant everywhere.
    expect(alphaOwnerAlertProfile("HK", {})).toBeNull();
  });
});

describe("withAlphaNoReplyLine", () => {
  it("appends exactly one no-reply line, idempotently", () => {
    const once = withAlphaNoReplyLine("New lead waiting");
    expect(once.endsWith(ALPHA_NO_REPLY_LINE)).toBe(true);
    expect(withAlphaNoReplyLine(once)).toBe(once);
  });
});

describe("edge lockstep copy", () => {
  it("reads Deno.env in the Edge runtime (the deployed default)", () => {
    vi.stubGlobal("Deno", {
      env: {
        get: (n: string) =>
          n === "TELNYX_INTL_ALPHA_PROFILE_ID" ? "deno-prof" : undefined
      }
    });
    try {
      expect(edgeIntlAlphaProfileId()).toBe("deno-prof");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("appends the no-reply line idempotently, same as the Node copy", () => {
    const once = edgeWithAlphaNoReplyLine("New lead waiting");
    expect(once.endsWith(edgeNoReplyLine)).toBe(true);
    expect(edgeWithAlphaNoReplyLine(once)).toBe(once);
  });

  it("agrees with the Node module on every export", () => {
    expect(edgeNoReplyLine).toBe(ALPHA_NO_REPLY_LINE);
    expect(edgeIntlAlphaProfileId(ENV_SET)).toBe(intlAlphaProfileId(ENV_SET));
    for (const country of ["US", "CA", "HK", "GB", null]) {
      expect(edgeAlphaOwnerAlertProfile(country, ENV_SET)).toBe(
        alphaOwnerAlertProfile(country, ENV_SET)
      );
      expect(edgeAlphaOwnerAlertProfile(country, {})).toBe(alphaOwnerAlertProfile(country, {}));
    }
    expect(edgeWithAlphaNoReplyLine("hi")).toBe(withAlphaNoReplyLine("hi"));
  });
});
