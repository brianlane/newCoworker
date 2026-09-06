import { describe, expect, it } from "vitest";
import { seedBusiness, serviceDb } from "./harness";
import { getOutreachSettings, upsertOutreachSettings } from "@/lib/outreach/db";

/**
 * `outreach_settings.send_as_email` against the REAL schema: the column the
 * sweep reads and the dashboard writes exists under that name, round-trips
 * through the same helpers production uses, and the check constraint refuses
 * what `normalizeSendAsEmail` refuses. A mocked query builder would pass all
 * of this against a column that was never created (docs/AUDIT-2026-08.md,
 * Lesson 1), so it is proved here instead.
 *
 * A non-off mode needs a postal address (or the exemption) under the
 * table's own check, so the row is written the way the panel would write a
 * configured tenant.
 */
describe("outreach_settings.send_as_email", () => {
  const db = serviceDb();

  it("stores and returns the alias through the production helpers, null by default", async () => {
    const businessId = await seedBusiness(db, "Send-as itest");
    const created = await upsertOutreachSettings(
      businessId,
      {
        mode: "manual",
        postal_address: "1 Example Plaza, Phoenix AZ",
        value_prop: "We answer every call."
      },
      db
    );
    // The migration default: no alias, so the provider keeps picking.
    expect(created.send_as_email).toBeNull();

    await upsertOutreachSettings(businessId, { send_as_email: "team@example.com" }, db);
    const read = await getOutreachSettings(businessId, db);
    expect(read?.send_as_email).toBe("team@example.com");

    await upsertOutreachSettings(businessId, { send_as_email: null }, db);
    expect((await getOutreachSettings(businessId, db))?.send_as_email).toBeNull();
  });

  it("refuses a display name or a list at the constraint, the same shapes the save refuses", async () => {
    const businessId = await seedBusiness(db, "Send-as shape itest");
    await upsertOutreachSettings(
      businessId,
      { mode: "manual", postal_address: "1 Example Plaza", value_prop: "We answer every call." },
      db
    );
    for (const bad of ["Brian <team@example.com>", "a@example.com, b@example.com", "team@example"]) {
      await expect(
        upsertOutreachSettings(businessId, { send_as_email: bad }, db),
        bad
      ).rejects.toThrow(/outreach_settings_send_as_email_shape/);
    }
    // The refused writes left the row exactly as it was.
    expect((await getOutreachSettings(businessId, db))?.send_as_email).toBeNull();
  });
});
