/**
 * Tests for the Vagaro webhook processing lib (src/lib/vagaro/webhook.ts):
 * token comparison, body parsing, phone normalization, contact sync
 * semantics (create vs fill-only), and the flow-event + sync orchestration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-flows/webhook-events", () => ({ processWebhookFlowEvent: vi.fn() }));
vi.mock("@/lib/customer-memory/db", () => ({
  CustomerExistsError: class CustomerExistsError extends Error {},
  getCustomerMemory: vi.fn(),
  createCustomerMemory: vi.fn(),
  updateCustomerOwnerFields: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  extractVagaroCustomer,
  normalizeVagaroPhone,
  parseVagaroWebhookBody,
  processVagaroWebhookEvent,
  syncVagaroCustomer,
  verificationTokenMatches,
  type VagaroWebhookEvent
} from "@/lib/vagaro/webhook";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import {
  createCustomerMemory,
  CustomerExistsError,
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";

function customerEvent(
  payload: Record<string, unknown>,
  overrides: Partial<VagaroWebhookEvent> = {}
): VagaroWebhookEvent {
  return {
    id: "evt-1",
    type: "customer",
    action: "created",
    payload,
    raw: { id: "evt-1", type: "customer", action: "created", payload },
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processWebhookFlowEvent).mockResolvedValue({
    enqueued: 1,
    flowsEvaluated: 2,
    flowsMatched: 1
  });
  vi.mocked(getCustomerMemory).mockResolvedValue(null);
});

describe("verificationTokenMatches", () => {
  it("matches equal tokens and rejects different or different-length ones", () => {
    expect(verificationTokenMatches("abc123", "abc123")).toBe(true);
    expect(verificationTokenMatches("abc123", "abc124")).toBe(false);
    expect(verificationTokenMatches("short", "longer-token")).toBe(false);
  });
});

describe("parseVagaroWebhookBody", () => {
  it("returns null for non-object or empty bodies", () => {
    expect(parseVagaroWebhookBody(null)).toBeNull();
    expect(parseVagaroWebhookBody("string")).toBeNull();
    expect(parseVagaroWebhookBody([1, 2])).toBeNull();
    expect(parseVagaroWebhookBody({})).toBeNull();
  });

  it("normalizes id/type/action across field aliases", () => {
    expect(
      parseVagaroWebhookBody({
        id: "evt-1",
        type: "appointment",
        action: "created",
        payload: { a: 1 }
      })
    ).toEqual({
      id: "evt-1",
      type: "appointment",
      action: "created",
      payload: { a: 1 },
      raw: { id: "evt-1", type: "appointment", action: "created", payload: { a: 1 } }
    });

    const aliased = parseVagaroWebhookBody({
      eventId: "evt-2",
      resourceType: "customer",
      payload: "not an object"
    });
    expect(aliased?.id).toBe("evt-2");
    expect(aliased?.type).toBe("customer");
    expect(aliased?.action).toBeNull();
    expect(aliased?.payload).toEqual({});
  });
});

describe("normalizeVagaroPhone", () => {
  it("handles E.164, US 10/11-digit, and junk", () => {
    expect(normalizeVagaroPhone(null)).toBeNull();
    expect(normalizeVagaroPhone("+1 (555) 123-0000")).toBe("+15551230000");
    expect(normalizeVagaroPhone("(555) 123-0000")).toBe("+15551230000");
    expect(normalizeVagaroPhone("15551230000")).toBe("+15551230000");
    expect(normalizeVagaroPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeVagaroPhone("+123")).toBeNull(); // too short after +
    expect(normalizeVagaroPhone("12345")).toBeNull();
    expect(normalizeVagaroPhone("22345678901")).toBeNull(); // 11 digits not starting with 1
  });
});

describe("extractVagaroCustomer", () => {
  it("prefers the nested customer object and assembles first/last names", () => {
    expect(
      extractVagaroCustomer({
        customer: {
          firstName: "Joe",
          lastName: "Plumber",
          mobilePhone: "555-123-0000",
          email: "Joe@Example.com"
        }
      })
    ).toEqual({ phone: "+15551230000", name: "Joe Plumber", email: "joe@example.com" });
  });

  it("falls back to flat payload fields and alternate keys", () => {
    expect(
      extractVagaroCustomer({ name: "Jane D", phoneNumber: "5551230001" })
    ).toEqual({ phone: "+15551230001", name: "Jane D", email: null });

    expect(
      extractVagaroCustomer({ fullName: "Full Name", cellPhone: "5551230002" })
    ).toEqual({ phone: "+15551230002", name: "Full Name", email: null });

    expect(extractVagaroCustomer({ firstName: "Solo", phone: "bad" })).toEqual({
      phone: null,
      name: "Solo",
      email: null
    });

    expect(extractVagaroCustomer({})).toEqual({ phone: null, name: null, email: null });
  });
});

describe("syncVagaroCustomer", () => {
  it("ignores non-customer events, delete actions, and phone-less customers", async () => {
    await syncVagaroCustomer(BIZ, customerEvent({}, { type: "appointment" }));
    await syncVagaroCustomer(BIZ, customerEvent({}, { action: "deleted" }));
    await syncVagaroCustomer(BIZ, customerEvent({ name: "No Phone" }));
    expect(getCustomerMemory).not.toHaveBeenCalled();
    expect(createCustomerMemory).not.toHaveBeenCalled();
  });

  it("creates a profile for a new customer", async () => {
    await syncVagaroCustomer(
      BIZ,
      customerEvent({ name: "Joe", phone: "5551230000", email: "joe@example.com" })
    );
    expect(createCustomerMemory).toHaveBeenCalledWith(BIZ, {
      customerE164: "+15551230000",
      displayName: "Joe",
      email: "joe@example.com"
    });
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("re-reads after an already-exists race and still applies this delivery's fields", async () => {
    const ExistsCtor = CustomerExistsError as unknown as new (e164: string) => Error;
    vi.mocked(createCustomerMemory).mockRejectedValueOnce(new ExistsCtor("+15551230000"));
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null) // pre-create existence check
      .mockResolvedValueOnce({
        customer_e164: "+15551230000",
        display_name: null,
        email: null
      } as never); // post-race re-read
    await syncVagaroCustomer(BIZ, customerEvent({ name: "Joe", phone: "5551230000" }));
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, "+15551230000", {
      displayName: "Joe"
    });
  });

  it("gives up gracefully when the post-race re-read finds nothing", async () => {
    const ExistsCtor = CustomerExistsError as unknown as new (e164: string) => Error;
    vi.mocked(createCustomerMemory).mockRejectedValueOnce(new ExistsCtor("+15551230000"));
    vi.mocked(getCustomerMemory).mockResolvedValue(null);
    await syncVagaroCustomer(BIZ, customerEvent({ name: "Joe", phone: "5551230000" }));
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("rethrows non-race create failures", async () => {
    vi.mocked(createCustomerMemory).mockRejectedValueOnce(new Error("db down"));
    await expect(
      syncVagaroCustomer(BIZ, customerEvent({ phone: "5551230000" }))
    ).rejects.toThrow(/db down/);
  });

  it("fills only the MISSING fields on an existing profile", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551230000",
      display_name: null,
      email: "kept@example.com"
    } as never);
    await syncVagaroCustomer(
      BIZ,
      customerEvent(
        { name: "Joe", phone: "5551230000", email: "new@example.com" },
        { action: "updated" }
      )
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, "+15551230000", {
      displayName: "Joe"
    });
  });

  it("no-ops when the existing profile already has both fields", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551230000",
      display_name: "Saved Name",
      email: "kept@example.com"
    } as never);
    await syncVagaroCustomer(
      BIZ,
      customerEvent({ name: "Joe", phone: "5551230000", email: "new@example.com" })
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("fills a missing email even when the payload carries no name", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551230000",
      display_name: "Saved Name",
      email: null
    } as never);
    await syncVagaroCustomer(
      BIZ,
      customerEvent({ phone: "5551230000", email: "new@example.com" })
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, "+15551230000", {
      email: "new@example.com"
    });
  });

  it("no-ops on an existing profile when the payload has neither name nor email", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551230000",
      display_name: null,
      email: null
    } as never);
    await syncVagaroCustomer(BIZ, customerEvent({ phone: "5551230000" }));
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });
});

describe("processVagaroWebhookEvent", () => {
  it("starts flows with source vagaro + the event id and reports the counts", async () => {
    const event = customerEvent({ phone: "5551230000" });
    const result = await processVagaroWebhookEvent(BIZ, event);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(BIZ, {
      source: "vagaro",
      data: event.raw,
      eventId: "evt-1"
    });
    expect(result).toEqual({
      enqueued: 1,
      flowsEvaluated: 2,
      flowsMatched: 1,
      contactSynced: true
    });
  });

  it("passes an undefined eventId when Vagaro omits one", async () => {
    const event = customerEvent({}, { id: null, type: "appointment" });
    const result = await processVagaroWebhookEvent(BIZ, event);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(BIZ, {
      source: "vagaro",
      data: event.raw,
      eventId: undefined
    });
    expect(result.contactSynced).toBe(false);
  });

  it("logs a contact-sync failure without losing the flow result", async () => {
    vi.mocked(getCustomerMemory).mockRejectedValueOnce("weird failure");
    const result = await processVagaroWebhookEvent(
      BIZ,
      customerEvent({ phone: "5551230000" })
    );
    expect(result.enqueued).toBe(1);
    expect(result.contactSynced).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro webhook contact sync failed",
      expect.objectContaining({ businessId: BIZ, error: "weird failure" })
    );

    vi.mocked(getCustomerMemory).mockRejectedValueOnce(new Error("db down"));
    await processVagaroWebhookEvent(BIZ, customerEvent({ phone: "5551230000" }));
    expect(logger.warn).toHaveBeenLastCalledWith(
      "vagaro webhook contact sync failed",
      expect.objectContaining({ error: "db down" })
    );
  });
});
