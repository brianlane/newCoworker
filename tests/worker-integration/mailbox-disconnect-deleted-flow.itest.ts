import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { SUPABASE_URL, createFlow, seedBusiness, serviceDb } from "./harness";

/**
 * Mailbox disconnect vs soft-deleted flows, against REAL Postgres.
 *
 * The DELETE /api/integrations/workspace guard fails closed: a connection any
 * flow still references 409s with "update those automations first". #1002
 * added ai_flows.deleted_at, and every read in src/lib/ai-flows/db.ts filters
 * it, but flowsReferencingWorkspaceConnection (the guard's query, older: #837)
 * did not. So an owner who deleted a flow that sent from their Gmail could
 * NEVER disconnect that mailbox: the 409 names a flow the dashboard no longer
 * shows, and there is nothing left for the owner to fix.
 *
 * This is deliberately an integration test: the defect is the shape of the
 * query that reaches the database, and the unit suite's mocked builder can
 * only assert the filter is present, not that it works.
 */

const CONN_ID = randomUUID();

function sendEmailFlow(fromConnectionId: string): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "manual" },
    steps: [
      {
        id: "s1",
        type: "send_email",
        to: "{{vars.lead_email}}",
        subject: "hello",
        body: "hi there",
        fromConnectionId
      }
    ]
  };
}

// The src/lib helper builds its own service client from app env vars; point
// them at the itest stack BEFORE its lazy createSupabaseServiceClient runs.
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

import { flowsReferencingWorkspaceConnection } from "@/lib/ai-flows/mailbox-steps";

describe("mailbox disconnect ignores soft-deleted flows", () => {
  let db: SupabaseClient;
  let businessId: string;

  beforeAll(async () => {
    db = serviceDb();
    businessId = await seedBusiness(db, "Mailbox Disconnect Itest");
  });

  it("a live flow referencing the mailbox still blocks the disconnect", async () => {
    const flowId = await createFlow(db, businessId, sendEmailFlow(CONN_ID));
    const referencing = await flowsReferencingWorkspaceConnection(businessId, CONN_ID, db);
    expect(referencing.map((f) => f.id)).toContain(flowId);
  });

  it("a soft-deleted flow no longer blocks the disconnect", async () => {
    // Soft-delete every flow for the business the way the product does:
    // stamp deleted_at and force enabled=false (the #1002 contract).
    const { error } = await db
      .from("ai_flows")
      .update({ deleted_at: new Date().toISOString(), enabled: false })
      .eq("business_id", businessId);
    expect(error).toBeNull();

    const referencing = await flowsReferencingWorkspaceConnection(businessId, CONN_ID, db);
    expect(referencing).toEqual([]);
  });
});
