import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHECKABLE_ACTIONS,
  checkBrowseActions,
  describeActionCheck,
  describePageDiagnostics,
  hasUnresolvedTemplateValue,
  noActionResolved,
  toCheckableActions,
  type ActionCheck
} from "@/lib/ai-flows/action-check";

const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const URL_OK = "https://portal.example.com/lead/7";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

const ACTIONS = [{ kind: "click_text", target: "Claim this lead" }];

beforeEach(() => {
  process.env.AIFLOW_RENDER_URL_TEMPLATE = "https://render-{businessId}.example.com/render";
  process.env.AIFLOW_RENDER_TOKEN = "tok-123";
});

afterEach(() => {
  delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
  delete process.env.AIFLOW_RENDER_TOKEN;
  vi.restoreAllMocks();
});

describe("describeActionCheck", () => {
  it("says what to do about each verdict, not just what it is", () => {
    expect(describeActionCheck({ kind: "click_text", target: "A", state: "ready" })).toContain(
      "Found it"
    );
    // "blocked" is normal for a button that wakes up once a field above it is
    // filled, so the copy must not read as a fault.
    expect(describeActionCheck({ kind: "click_text", target: "A", state: "blocked" })).toContain(
      "only wakes up"
    );
    // The most common real cause of "absent" is the wizard limitation, not a
    // wrong selector, and an owner not told that will "fix" a working step.
    expect(describeActionCheck({ kind: "click_text", target: "A", state: "absent" })).toContain(
      "only appears after an earlier action"
    );
  });

  it("prefers the sidecar's reason when it has one", () => {
    const line = describeActionCheck({
      kind: "click_selector",
      target: "button[",
      state: "absent",
      detail: "Unexpected token in selector"
    });
    expect(line).toContain("Unexpected token in selector");
  });

  it("lists the choices a dropdown does offer", () => {
    const line = describeActionCheck({
      kind: "select_option",
      target: "select[name=stage]",
      state: "missing_option",
      options: ["New", "Spoke with them"]
    });
    expect(line).toContain("New, Spoke with them");
  });

  it("handles a dropdown whose options could not be listed", () => {
    const line = describeActionCheck({
      kind: "select_option",
      target: "s",
      state: "missing_option"
    });
    expect(line).toContain("does not offer that choice");
    expect(line).not.toContain("It offers:");
  });
});

describe("noActionResolved", () => {
  it("is true only when EVERY action came back absent", () => {
    const absent: ActionCheck = { kind: "click_text", target: "A", state: "absent" };
    const ready: ActionCheck = { kind: "click_text", target: "B", state: "ready" };
    // One miss mid-sequence is usually the wizard limitation; a total miss
    // normally means the page never really loaded.
    expect(noActionResolved([absent, absent])).toBe(true);
    expect(noActionResolved([absent, ready])).toBe(false);
    expect(noActionResolved([])).toBe(false);
  });
});

describe("checkBrowseActions", () => {
  it("asks the sidecar for a check, and never for a run", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        finalUrl: URL_OK,
        checks: [{ kind: "click_text", target: "Claim this lead", state: "ready" }]
      })
    );

    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      integrationLabel: "HomeLight",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toMatchObject({ ok: true, finalUrl: URL_OK });
    const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    // checkOnly is what routes the sidecar to its dry-run responder. Without
    // it this request would CLICK the claim button on a real referral.
    expect(sent.checkOnly).toBe(true);
    // A dry run is one page, one pass: looping or asserting an after-state
    // would both require performing the actions.
    expect(sent).not.toHaveProperty("forEachLink");
    expect(sent).not.toHaveProperty("expectText");
    expect(sent.auth).toEqual({ integrationLabel: "HomeLight" });
    // Its OWN path. A box that has not been redeployed ignores checkOnly and
    // PERFORMS the actions, so the flag alone would let this button click a
    // live claim button during the window between merge and redeploy.
    expect(endpoint).toBe(`https://render-${BIZ}.example.com/check-actions`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("normalizes a missing value to an empty string, as the sidecar parser expects", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ checks: [] }));
    await checkBrowseActions(BIZ, URL_OK, [{ kind: "fill_selector", target: "input" }], {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const sent = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    );
    expect(sent.actions).toEqual([{ kind: "fill_selector", target: "input", value: "" }]);
  });

  it("drops half-typed actions rather than sending a target the sidecar will reject", async () => {
    // The editor's "+ action" adds an empty row, so an owner mid-edit always
    // has one. parseActions returns null for the whole array on a blank
    // target, which would fail the entire check for an unrelated reason.
    const fetchImpl = vi.fn(async () => jsonResponse({ checks: [] }));
    await checkBrowseActions(
      BIZ,
      URL_OK,
      [
        { kind: "click_text", target: "Accept" },
        { kind: "click_text", target: "" }
      ],
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    const sent = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    );
    expect(sent.actions).toHaveLength(1);
  });

  it("refuses when nothing usable is left, without calling the sidecar", async () => {
    const fetchImpl = vi.fn();
    const result = await checkBrowseActions(BIZ, URL_OK, [{ kind: "click_text", target: "  " }], {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "no_actions" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps the sequence at the sidecar's own limit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ checks: [] }));
    await checkBrowseActions(
      BIZ,
      URL_OK,
      Array.from({ length: 20 }, (_, i) => ({ kind: "click_text", target: `T${i}` })),
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    const sent = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    );
    expect(sent.actions).toHaveLength(MAX_CHECKABLE_ACTIONS);
  });

  it("omits auth for a public page, and the header when there is no token", async () => {
    delete process.env.AIFLOW_RENDER_TOKEN;
    const fetchImpl = vi.fn(async () => jsonResponse({ checks: [] }));
    await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("auth");
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("returns the screenshot when the sidecar sent one", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ checks: [], screenshotBase64: "aGVsbG8=" })
    );
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({ ok: true, screenshotBase64: "aGVsbG8=" });
  });

  it("omits an empty screenshot rather than passing a blank data URI to the page", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ checks: [], screenshotBase64: "" }));
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok && result.screenshotBase64).toBeUndefined();
  });

  it("falls back to the requested URL when the sidecar reports no final one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ checks: [] }));
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({ ok: true, finalUrl: URL_OK });
  });

  it("refuses an unsafe address without calling the sidecar", async () => {
    const fetchImpl = vi.fn();
    const result = await checkBrowseActions(BIZ, "http://169.254.169.254/", ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({ ok: false, error: "unsafe_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports not_configured when the platform has no render template", async () => {
    delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
    const fetchImpl = vi.fn();
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names a bad login separately from a failed page", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "login_failed", detail: "submit never appeared" })
    );
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      integrationLabel: "HomeLight",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({
      ok: false,
      error: "login_failed",
      detail: "submit never appeared"
    });
  });

  it("falls back to the error code when the sidecar gives no detail", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_check_only" }));
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({
      ok: false,
      error: "render_failed",
      detail: "invalid_check_only"
    });
  });

  it("treats a non-2xx, a malformed body and a transport failure as render failures", async () => {
    const cases: Array<[unknown, number]> = [
      [{}, 502],
      [null, 200],
      [{ checks: "not an array" }, 200]
    ];
    for (const [body, status] of cases) {
      const fetchImpl = vi.fn(async () => jsonResponse(body, status));
      const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
        fetchImpl: fetchImpl as unknown as typeof fetch
      });
      expect(result).toMatchObject({ ok: false, error: "render_failed" });
    }

    const thrower = vi.fn(async () => {
      throw new Error("box unreachable");
    });
    expect(
      await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
        fetchImpl: thrower as unknown as typeof fetch
      })
    ).toEqual({ ok: false, error: "render_failed", detail: "box unreachable" });

    const nonError = vi.fn(async () => {
      throw "timed out";
    });
    expect(
      await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
        fetchImpl: nonError as unknown as typeof fetch
      })
    ).toEqual({ ok: false, error: "render_failed", detail: "timed out" });
  });

  it("treats unparseable JSON as a render failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      }
    }));
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({ ok: false, error: "render_failed" });
  });
});


describe("describePageDiagnostics", () => {
  it("is empty when the page had nothing to report", () => {
    expect(describePageDiagnostics(undefined)).toEqual([]);
    expect(describePageDiagnostics({})).toEqual([]);
    expect(describePageDiagnostics({ consoleErrors: [] })).toEqual([]);
  });

  it("reports the page's own complaints, which is what separates two identical-looking results", () => {
    // On HomeLight this exact shape was the whole diagnosis: a lazy-loaded
    // script served an HTML error page, so the stage editor never mounted and
    // the controls were genuinely absent for a reason that has nothing to do
    // with the selector (PR #1508).
    const lines = describePageDiagnostics({ pageErrors: ["Unexpected token '<'"] });
    expect(lines).toEqual(["pageErrors: Unexpected token '<'"]);
  });

  it("caps a noisy page and says how many were dropped", () => {
    const lines = describePageDiagnostics({
      consoleErrors: Array.from({ length: 9 }, (_, i) => `boom ${i}`)
    });
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("consoleErrors: ... 4 more");
  });

  it("names our OWN blocked requests rather than letting them read as portal faults", () => {
    // The guard aborts with "blockedbyclient"; Chromium reports it back as
    // net::ERR_BLOCKED_BY_CLIENT, so matching the abort argument alone never
    // fires. Both spellings must be caught.
    for (const spelling of ["net::ERR_BLOCKED_BY_CLIENT GET https://x/y", "blockedbyclient GET https://x/y"]) {
      const lines = describePageDiagnostics({ failedRequests: [spelling] });
      expect(lines[lines.length - 1]).toContain("our own safety guard");
    }
  });

  it("does not fire that note on an unrelated failure code", () => {
    const lines = describePageDiagnostics({ failedRequests: ["net::ERR_ABORTED GET https://x/y"] });
    expect(lines.join(" ")).not.toContain("safety guard");
  });

  it("ignores a malformed diagnostics group instead of throwing", () => {
    expect(
      describePageDiagnostics({ consoleErrors: "not an array" as unknown as string[] })
    ).toEqual([]);
  });
});

describe("checkBrowseActions diagnostics", () => {
  it("carries what the page reported, on SUCCESS", async () => {
    // The case that matters: a page whose data requests failed returns 200
    // with real markup and missing controls, so without this the dry run says
    // "not found" and the owner rewrites a correct selector.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        checks: [{ kind: "click_text", target: "Claim", state: "absent" }],
        diagnostics: { pageErrors: ["Unexpected token '<'"] }
      })
    );
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({
      ok: true,
      diagnostics: { pageErrors: ["Unexpected token '<'"] }
    });
  });

  it("omits the field when the page reported nothing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ checks: [] }));
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok && result.diagnostics).toBeUndefined();
  });
});


describe("a sidecar that has not been redeployed", () => {
  it("is named as such rather than reported as a broken page", async () => {
    // 404 is the safe answer from an old box: it has never heard of this path.
    // Saying "the page could not be opened" would send the owner checking an
    // address that is perfectly fine.
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "not_updated" });
  });

  it("still treats other non-2xx statuses as page failures", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const result = await checkBrowseActions(BIZ, URL_OK, ACTIONS, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "render_failed", detail: "sidecar http 500" });
  });
});


describe("toCheckableActions", () => {
  it("carries the editor's valueTemplate across as the value the sidecar wants", () => {
    // The step schema calls it valueTemplate; parseActions wants `value`, and
    // rejects the WHOLE array when a value-requiring kind has none. Passing
    // the editor objects through unchanged turned "the dropdown does not offer
    // that choice" into a failed page open blaming the address.
    expect(
      toCheckableActions([
        { kind: "select_option", target: "select[name=stage]", valueTemplate: "Spoke with them" }
      ])
    ).toEqual([
      { kind: "select_option", target: "select[name=stage]", value: "Spoke with them" }
    ]);
  });

  it("omits the value entirely when there is none, rather than sending undefined", () => {
    expect(toCheckableActions([{ kind: "click_text", target: "Accept" }])).toEqual([
      { kind: "click_text", target: "Accept" }
    ]);
    expect(
      toCheckableActions([{ kind: "click_text", target: "Accept", valueTemplate: "" }])
    ).toEqual([{ kind: "click_text", target: "Accept" }]);
  });

  it("keeps click_role's accessible name, the other value-requiring kind", () => {
    expect(
      toCheckableActions([{ kind: "click_role", target: "option", valueTemplate: "09:00" }])
    ).toEqual([{ kind: "click_role", target: "option", value: "09:00" }]);
  });
});

describe("hasUnresolvedTemplateValue", () => {
  it("is true when a kind that MATCHES on its value still holds a template", () => {
    // select_option and click_role compare against the value, and there is no
    // run here to resolve {{vars.x}}, so a correct step would otherwise read
    // as a missing option.
    expect(
      hasUnresolvedTemplateValue([
        { kind: "select_option", target: "s", valueTemplate: "{{vars.stage}}" }
      ])
    ).toBe(true);
    expect(
      hasUnresolvedTemplateValue([{ kind: "click_role", target: "option", valueTemplate: "{{vars.slot}}" }])
    ).toBe(true);
  });

  it("ignores a template on a kind the dry run never compares", () => {
    // A dry run never types, so a fill template is irrelevant and warning
    // about it would be noise on almost every real step.
    expect(
      hasUnresolvedTemplateValue([
        { kind: "fill_selector", target: "textarea", valueTemplate: "{{vars.actions_taken}}" }
      ])
    ).toBe(false);
  });

  it("is false for plain literal values and for no value at all", () => {
    expect(
      hasUnresolvedTemplateValue([{ kind: "select_option", target: "s", valueTemplate: "New" }])
    ).toBe(false);
    expect(hasUnresolvedTemplateValue([{ kind: "select_option", target: "s" }])).toBe(false);
  });
});
