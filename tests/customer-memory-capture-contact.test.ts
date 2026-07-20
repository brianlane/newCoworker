import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/customer-memory/db", () => ({
  linkCustomerEmail: vi.fn(),
  recordInteractionAndIncrement: vi.fn()
}));
vi.mock("@/lib/ai-flows/contact-event-hooks", () => ({ fireContactEvent: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import { ensureCapturedContact } from "@/lib/customer-memory/capture-contact";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  linkCustomerEmail,
  recordInteractionAndIncrement
} from "@/lib/customer-memory/db";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15551234567";

const mockClientFactory = vi.mocked(createSupabaseServiceClient);
const mockRollup = vi.mocked(recordInteractionAndIncrement);
const mockLink = vi.mocked(linkCustomerEmail);
const mockFire = vi.mocked(fireContactEvent);

type PrecheckResult = { data: unknown; error: unknown };

/**
 * Chainable fake for the two contact queries the module runs:
 *   - `.from("contacts").select().eq().or().maybeSingle()` (existence check)
 *   - `.from("contacts").update().eq().eq()` (source tag on the new row)
 */
function fakeDb(
  precheck: PrecheckResult | Error,
  opts: { tagError?: { message: string } | null } = {}
) {
  const maybeSingle =
    precheck instanceof Error
      ? vi.fn().mockRejectedValue(precheck)
      : vi.fn().mockResolvedValue(precheck);
  const or = vi.fn().mockReturnValue({ maybeSingle });
  const selectEq = vi.fn().mockReturnValue({ or });
  const select = vi.fn().mockReturnValue({ eq: selectEq });
  const updateCalls: Array<Record<string, unknown>> = [];
  const update = vi.fn((patch: Record<string, unknown>) => {
    updateCalls.push(patch);
    const eq2 = vi.fn().mockResolvedValue({ error: opts.tagError ?? null });
    return { eq: vi.fn().mockReturnValue({ eq: eq2 }) };
  });
  const from = vi.fn().mockReturnValue({ select, update });
  return { client: { from } as never, from, eq: selectEq, or, update, updateCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRollup.mockResolvedValue({} as never);
  mockLink.mockResolvedValue(undefined);
  mockFire.mockResolvedValue(undefined);
});

describe("ensureCapturedContact", () => {
  it("creates a new contact (rollup + source tag) and fires contact_created with name + email + tag", async () => {
    const { client, eq, or, updateCalls } = fakeDb({ data: null, error: null });
    mockClientFactory.mockResolvedValue(client);

    const out = await ensureCapturedContact(BIZ, {
      e164: PHONE,
      name: " Ada Lovelace ",
      email: " ada@example.com ",
      channel: "voice"
    });

    expect(out).toEqual({ created: true });
    // Alias-aware existence pre-check.
    expect(eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(or).toHaveBeenCalledWith(
      `customer_e164.eq.${PHONE},alias_e164s.cs.{${PHONE}}`
    );
    expect(mockRollup).toHaveBeenCalledWith(
      BIZ,
      PHONE,
      "voice",
      { displayName: "Ada Lovelace" },
      client
    );
    expect(mockLink).toHaveBeenCalledWith(BIZ, PHONE, "ada@example.com", client);
    expect(updateCalls).toEqual([
      expect.objectContaining({ tags: ["Voice Capture"] })
    ]);
    expect(mockFire).toHaveBeenCalledTimes(1);
    const [firedBiz, event] = mockFire.mock.calls[0];
    expect(firedBiz).toBe(BIZ);
    expect(event).toMatchObject({
      kind: "contact_created",
      contact: {
        e164: PHONE,
        name: "Ada Lovelace",
        email: "ada@example.com",
        tags: ["Voice Capture"]
      }
    });
    expect(event.dedupeKey).toMatch(
      new RegExp(`^ce:created:\\${PHONE}:\\d+$`)
    );
  });

  it("fires a bare event (no name/email keys) with the channel's source tag", async () => {
    const { client } = fakeDb({ data: null, error: null });
    mockClientFactory.mockResolvedValue(client);

    const out = await ensureCapturedContact(BIZ, {
      e164: PHONE,
      name: "   ",
      channel: "webchat"
    });

    expect(out).toEqual({ created: true });
    expect(mockRollup).toHaveBeenCalledWith(
      BIZ,
      PHONE,
      "webchat",
      { displayName: null },
      client
    );
    expect(mockLink).not.toHaveBeenCalled();
    const [, event] = mockFire.mock.calls[0];
    expect(event.contact).toEqual({ e164: PHONE, tags: ["Webchat Lead"] });
  });

  it("survives a source-tag write failure (warn; event still fires with the tag)", async () => {
    const { client } = fakeDb(
      { data: null, error: null },
      { tagError: { message: "tag denied" } }
    );
    mockClientFactory.mockResolvedValue(client);

    const out = await ensureCapturedContact(BIZ, { e164: PHONE, channel: "voice" });
    expect(out).toEqual({ created: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: source tag failed",
      expect.objectContaining({ error: "tag denied" })
    );
    expect(mockFire).toHaveBeenCalledTimes(1);
  });

  it("skips the tag write (and event tags) for channels without a source tag", async () => {
    const { client, update } = fakeDb({ data: null, error: null });
    mockClientFactory.mockResolvedValue(client);

    const out = await ensureCapturedContact(BIZ, { e164: PHONE, channel: "dashboard" });
    expect(out).toEqual({ created: true });
    expect(update).not.toHaveBeenCalled();
    const [, event] = mockFire.mock.calls[0];
    expect(event.contact).toEqual({ e164: PHONE });
  });

  it("does NOT fire for an existing contact (rollup + link still run)", async () => {
    const { client } = fakeDb({ data: { id: "row" }, error: null });
    mockClientFactory.mockResolvedValue(client);

    const out = await ensureCapturedContact(BIZ, {
      e164: PHONE,
      email: "ada@example.com",
      channel: "messenger"
    });

    expect(out).toEqual({ created: false });
    expect(mockRollup).toHaveBeenCalledTimes(1);
    expect(mockLink).toHaveBeenCalledTimes(1);
    expect(mockFire).not.toHaveBeenCalled();
  });

  it("fails safe on a pre-check ERROR result: treated as existing, no event", async () => {
    const { client } = fakeDb({ data: null, error: { message: "read blip" } });
    mockClientFactory.mockResolvedValue(client);

    const out = await ensureCapturedContact(BIZ, { e164: PHONE, channel: "voice" });

    expect(out).toEqual({ created: false });
    expect(mockRollup).toHaveBeenCalledTimes(1);
    expect(mockFire).not.toHaveBeenCalled();
  });

  it("fails safe on a pre-check THROW (Error and non-Error shapes): warns, no event", async () => {
    const { client } = fakeDb(new Error("db down"));
    mockClientFactory.mockResolvedValue(client);

    const out = await ensureCapturedContact(BIZ, { e164: PHONE, channel: "voice" });
    expect(out).toEqual({ created: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: existence pre-check failed",
      expect.objectContaining({ error: "db down" })
    );
    expect(mockFire).not.toHaveBeenCalled();

    // Non-Error rejection (PG drivers can surface plain strings).
    const maybeSingle = vi.fn().mockRejectedValue("precheck boom");
    const or = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ or });
    const select = vi.fn().mockReturnValue({ eq });
    mockClientFactory.mockResolvedValue({
      from: vi.fn().mockReturnValue({ select })
    } as never);
    const outStr = await ensureCapturedContact(BIZ, { e164: PHONE, channel: "voice" });
    expect(outStr).toEqual({ created: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: existence pre-check failed",
      expect.objectContaining({ error: "precheck boom" })
    );
  });

  it("skips the event when the rollup fails (row may not exist); email still links", async () => {
    const { client } = fakeDb({ data: null, error: null });
    mockClientFactory.mockResolvedValue(client);
    mockRollup.mockRejectedValueOnce(new Error("rollup boom"));

    const out = await ensureCapturedContact(BIZ, {
      e164: PHONE,
      email: "ada@example.com",
      channel: "webchat"
    });

    expect(out).toEqual({ created: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: rollup failed",
      expect.objectContaining({ channel: "webchat", error: "rollup boom" })
    );
    expect(mockLink).toHaveBeenCalledTimes(1);
    expect(mockFire).not.toHaveBeenCalled();

    // Non-Error rejection shape.
    mockRollup.mockRejectedValueOnce("rollup str boom");
    const outStr = await ensureCapturedContact(BIZ, { e164: PHONE, channel: "webchat" });
    expect(outStr).toEqual({ created: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: rollup failed",
      expect.objectContaining({ error: "rollup str boom" })
    );
  });

  it("survives a link failure (Error and non-Error shapes) — event still fires for a new lead", async () => {
    const { client } = fakeDb({ data: null, error: null });
    mockClientFactory.mockResolvedValue(client);
    mockLink.mockRejectedValueOnce(new Error("link boom"));

    const out = await ensureCapturedContact(BIZ, {
      e164: PHONE,
      email: "ada@example.com",
      channel: "voice"
    });
    expect(out).toEqual({ created: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: linkCustomerEmail failed",
      expect.objectContaining({ error: "link boom" })
    );
    expect(mockFire).toHaveBeenCalledTimes(1);

    mockLink.mockRejectedValueOnce("link str boom");
    const outStr = await ensureCapturedContact(BIZ, {
      e164: PHONE,
      email: "ada@example.com",
      channel: "voice"
    });
    expect(outStr).toEqual({ created: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: linkCustomerEmail failed",
      expect.objectContaining({ error: "link str boom" })
    );
  });

  it("returns created:false when the service client is unavailable (Error and non-Error)", async () => {
    mockClientFactory.mockRejectedValueOnce(new Error("no env"));
    const out = await ensureCapturedContact(BIZ, { e164: PHONE, channel: "voice" });
    expect(out).toEqual({ created: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: service client unavailable",
      expect.objectContaining({ error: "no env" })
    );
    expect(mockRollup).not.toHaveBeenCalled();
    expect(mockFire).not.toHaveBeenCalled();

    mockClientFactory.mockRejectedValueOnce("client boom");
    const outStr = await ensureCapturedContact(BIZ, { e164: PHONE, channel: "voice" });
    expect(outStr).toEqual({ created: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "capture-contact: service client unavailable",
      expect.objectContaining({ error: "client boom" })
    );
  });

  it("uses a caller-provided client without constructing its own", async () => {
    const { client } = fakeDb({ data: null, error: null });

    const out = await ensureCapturedContact(
      BIZ,
      { e164: PHONE, channel: "sms" },
      client
    );

    expect(out).toEqual({ created: true });
    expect(mockClientFactory).not.toHaveBeenCalled();
    expect(mockRollup).toHaveBeenCalledWith(BIZ, PHONE, "sms", { displayName: null }, client);
  });
});
