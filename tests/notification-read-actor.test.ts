import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/view-as", () => ({
  resolveViewAsContext: vi.fn()
}));

import { resolveViewAsContext } from "@/lib/admin/view-as";
import { resolveNotificationReadActor } from "@/lib/notifications/read-actor";

const OWNER = { userId: "u1", email: "owner@tenant.com", isAdmin: false };
const ADMIN = { userId: "u2", email: "admin@newcoworker.com", isAdmin: true };

beforeEach(() => vi.clearAllMocks());

describe("resolveNotificationReadActor", () => {
  it("stamps a plain tenant session as the owner, with no view-as lookup", async () => {
    expect(await resolveNotificationReadActor(OWNER, "biz")).toBe("owner");
    expect(resolveViewAsContext).not.toHaveBeenCalled();
  });

  it("stamps an admin view-as session as admin", async () => {
    // The whole reason the column exists: admin view-as reaches this route
    // with the tenant's own permissions, and before this its read stamp was
    // indistinguishable from the owner's.
    vi.mocked(resolveViewAsContext).mockResolvedValue({
      ownerEmail: "owner@tenant.com",
      viewAs: { businessId: "biz", name: "Tenant", tier: "standard", selfOwned: false }
    });
    expect(await resolveNotificationReadActor(ADMIN, "biz")).toBe("admin");
  });

  it("stamps an admin with no view-as cookie as admin", async () => {
    vi.mocked(resolveViewAsContext).mockResolvedValue({
      ownerEmail: "admin@newcoworker.com",
      viewAs: null
    });
    expect(await resolveNotificationReadActor(ADMIN, "biz")).toBe("admin");
  });

  it("stamps the admin's OWN tenant as the owner", async () => {
    // The internal HQ tenant: the impersonated business's owner_email IS the
    // admin's address, and resolveViewAsContext already models that as
    // selfOwned. Calling those reads "admin" would report our own dashboard
    // as unread by anybody, which is false.
    vi.mocked(resolveViewAsContext).mockResolvedValue({
      ownerEmail: "admin@newcoworker.com",
      viewAs: { businessId: "hq", name: "New Coworker", tier: "enterprise", selfOwned: true }
    });
    expect(await resolveNotificationReadActor(ADMIN, "hq")).toBe("owner");
  });

  it("does not let a selfOwned session vouch for a DIFFERENT business", async () => {
    vi.mocked(resolveViewAsContext).mockResolvedValue({
      ownerEmail: "admin@newcoworker.com",
      viewAs: { businessId: "hq", name: "New Coworker", tier: "enterprise", selfOwned: true }
    });
    expect(await resolveNotificationReadActor(ADMIN, "someone-else")).toBe("admin");
  });
});
