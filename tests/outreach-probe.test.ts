/**
 * Prospecting site probe (src/lib/outreach/probe.ts): the findings are only
 * ever ABSENCES of a capability marker, the address ranking prefers the
 * prospect's own role mailbox, and every read failure degrades to "not
 * reachable" instead of throwing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  detectFindings,
  extractEmails,
  PROBE_MAX_BYTES,
  PROBE_TIMEOUT_MS,
  probeSite
} from "@/lib/outreach/probe";

/** A page that has every capability, so it yields no findings at all. */
const FULLY_EQUIPPED = `
  <a href="tel:+16025550100">call</a>
  <a href="sms:+16025550100">text us</a>
  <a href="https://calendly.com/acme/30min">book now</a>
  <script src="https://widget.intercom.io/widget/abc"></script>
  <p>open 24 hours, every day</p>
`.toLowerCase();

function htmlResponse(body: string, ok = true) {
  return { ok, text: async () => body } as unknown as Response;
}

describe("detectFindings", () => {
  it("finds nothing on a site that already does all of it", () => {
    expect(detectFindings(FULLY_EQUIPPED)).toEqual([]);
  });

  it("reports each missing capability with the evidence behind it", () => {
    const codes = detectFindings("<p>we are a plumbing company</p>").map((f) => f.code);
    expect(codes).toEqual([
      "no_online_booking",
      "no_chat_widget",
      "no_text_option",
      "no_tap_to_call"
    ]);
    // Every finding carries a detail: the pitch may only say what is here.
    expect(detectFindings("<p>hi</p>").every((f) => f.detail.length > 0)).toBe(true);
  });

  it("quotes the weekend-closed line it matched", () => {
    const findings = detectFindings(`${FULLY_EQUIPPED} <p>closed on weekends</p>`);
    expect(findings).toEqual([
      { code: "closed_weekends", detail: expect.stringContaining("closed on weekends") }
    ]);
  });

  it("reports an after-hours gap only when the posted close is early", () => {
    const early = detectFindings(`${FULLY_EQUIPPED} <p>mon - fri 8:00 am - 5:00 pm</p>`);
    expect(early).toEqual([
      { code: "after_hours_gap", detail: expect.stringContaining("8:00 am - 5:00 pm") }
    ]);

    // Open until 8pm: no gap worth mentioning, so nothing is claimed.
    expect(detectFindings(`${FULLY_EQUIPPED} <p>mon to fri 8 am to 8 pm</p>`)).toEqual([]);
    // An en dash separator is the same claim.
    expect(
      detectFindings(`${FULLY_EQUIPPED} <p>mon \u2013 fri 9:00 am \u2013 4:30 pm</p>`).map(
        (f) => f.code
      )
    ).toEqual(["after_hours_gap"]);
  });
});

describe("extractEmails", () => {
  it("prefers the prospect's own role mailbox over anything else", () => {
    const html = `
      contact brian.personal@gmail.com or info@acme.com or someone@acme.com
      or hello@partner.com
    `.toLowerCase();
    expect(extractEmails(html, "acme.com")[0]).toBe("info@acme.com");
    // Own-domain beats a third-party role mailbox.
    expect(extractEmails("someone@acme.com hello@partner.com", "acme.com")[0]).toBe(
      "someone@acme.com"
    );
    // A subdomain of the prospect still counts as their own.
    expect(extractEmails("info@mail.acme.com other@x.com", "acme.com")[0]).toBe(
      "info@mail.acme.com"
    );
  });

  it("drops platform boilerplate, no-reply senders, asset filenames, and duplicates", () => {
    const html = `
      no-reply@acme.com donotreply@acme.com someone@example.com
      logo@2x.png sprite@3x.jpeg real@acme.com real@acme.com
    `.toLowerCase();
    expect(extractEmails(html, "acme.com")).toEqual(["real@acme.com"]);
    expect(extractEmails("nothing here", "acme.com")).toEqual([]);
  });
});

describe("probeSite", () => {
  it("returns findings and the best address from the homepage", async () => {
    const fetchImpl = vi.fn(async () =>
      htmlResponse("<p>call us</p> info@acme.com")
    ) as unknown as typeof fetch;
    const result = await probeSite("https://acme.com", "acme.com", { fetchImpl });
    expect(result.reachable).toBe(true);
    expect(result.email).toBe("info@acme.com");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tries one conventional contact path when the homepage publishes no address", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      htmlResponse(String(url).includes("/contact") ? "hello@acme.com" : "<p>no address</p>")
    ) as unknown as typeof fetch;
    const result = await probeSite("https://acme.com/", "acme.com", { fetchImpl });
    expect(result.email).toBe("hello@acme.com");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      "https://acme.com/contact"
    );
  });

  it("gives up on an address when neither page has one", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("<p>nothing</p>")) as unknown as typeof fetch;
    const result = await probeSite("https://acme.com", "acme.com", { fetchImpl });
    expect(result.email).toBeNull();
    expect(result.reachable).toBe(true);
  });

  it("keeps the findings when the contact page itself is unreadable", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/contact")
        ? htmlResponse("nope", false)
        : htmlResponse("<p>homepage</p>")
    ) as unknown as typeof fetch;
    const result = await probeSite("https://acme.com", "acme.com", { fetchImpl });
    expect(result.reachable).toBe(true);
    expect(result.email).toBeNull();
  });

  it("reports an unreadable site instead of throwing", async () => {
    const refused = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeSite("https://acme.com", "acme.com", { fetchImpl: refused })).toEqual({
      findings: [],
      email: null,
      reachable: false,
      failure: "site unreadable"
    });

    const notFound = vi.fn(async () => htmlResponse("missing", false)) as unknown as typeof fetch;
    expect(
      (await probeSite("https://acme.com", "acme.com", { fetchImpl: notFound })).reachable
    ).toBe(false);
  });

  /**
   * Doubles as the backtracking regression: an unbounded local part in the
   * address regex turns a long run of word characters (any minified script)
   * into quadratic backtracking, which hung this test outright. If the bounds
   * in extractEmails are ever loosened, this test stops finishing.
   */
  it("caps the body it reads and identifies itself honestly", async () => {
    const huge = `${"x".repeat(PROBE_MAX_BYTES + 500)}info@acme.com`;
    const fetchImpl = vi.fn(async () => htmlResponse(huge)) as unknown as typeof fetch;
    // The address sits past the cap, so it is not found: the cap is real.
    const result = await probeSite("https://acme.com", "acme.com", { fetchImpl });
    expect(result.email).toBeNull();
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as { headers: Record<string, string> })["headers"]["User-Agent"]).toMatch(
      /NewCoworkerProspectBot/
    );
  });

  it("aborts a page read that outlasts the timeout, so one slow site cannot stall the pass", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        })
    ) as unknown as typeof fetch;
    const pending = probeSite("https://slow.example", "slow.example", { fetchImpl });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ reachable: false, failure: "site unreadable" });
    vi.useRealTimers();
  });

  it("defaults to the global fetch when no impl is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(htmlResponse("<p>page</p> info@acme.com"));
    expect((await probeSite("https://acme.com", "acme.com")).email).toBe("info@acme.com");
    spy.mockRestore();
  });
});
