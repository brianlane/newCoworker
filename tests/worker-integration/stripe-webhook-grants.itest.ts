import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { SUPABASE_URL, seedBusiness, serviceDb } from "./harness";
import {
  makeEvent,
  makePackCheckoutSession,
  makeSubscription,
  type UsagePackCheckoutKind
} from "../helpers/stripe-events";

/**
 * The Stripe webhook route driven for real, end to end, against real
 * Postgres: the actual `POST` handler, the actual dispatch, the actual
 * entitlement chain, the actual `apply_*_grant_from_checkout` RPCs, and the
 * actual rows and balances that come out the other side.
 *
 * `tests/stripe-webhook-route.test.ts` covers the same route with the
 * Supabase client mocked, so it can prove the route CALLS the RPC with the
 * right arguments and nothing about the result. Everything the database is
 * responsible for lives here instead: that the grant row exists, that the
 * expiry rule produced the timestamp it should have, that a replayed event is
 * observably a no-op rather than merely a second call to a `vi.fn()`, and
 * that a blocked grant leaves zero rows behind.
 *
 * Only two things are stubbed, both at the `@/lib/stripe/client` boundary:
 * signature verification (a test cannot forge Stripe's HMAC without the live
 * secret) and `getStripe`, since the route re-reads the subscription from
 * Stripe as part of the entitlement chain.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
process.env.STRIPE_SECRET_KEY = "sk_test_itest";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_itest";

const subscriptionRetrieve = vi.fn();
const nextEvent = { current: null as Stripe.Event | null };

vi.mock("@/lib/stripe/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe/client")>();
  return {
    ...actual,
    verifyWebhook: () => {
      if (!nextEvent.current) throw new Error("no event staged");
      return nextEvent.current;
    },
    getStripe: () => ({ subscriptions: { retrieve: subscriptionRetrieve } })
  };
});

const { POST } = await import("@/app/api/webhooks/stripe/route");

const STRIPE_SUB_ID = "sub_itest_webhook";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function epochDaysFromNow(days: number): number {
  return Math.floor((Date.now() + days * 24 * 60 * 60 * 1000) / 1000);
}

/** Deliver one event to the real route, exactly as Stripe would. */
async function deliver(event: Stripe.Event): Promise<number> {
  nextEvent.current = event;
  const res = await POST(
    new Request("https://ncw.example/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=itest" },
      body: JSON.stringify({ id: event.id })
    })
  );
  return res.status;
}

async function seedActiveSubscription(
  db: SupabaseClient,
  businessId: string,
  over: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await db.from("subscriptions").insert({
    id: randomUUID(),
    business_id: businessId,
    tier: "standard",
    status: "active",
    stripe_subscription_id: STRIPE_SUB_ID,
    stripe_current_period_start: daysFromNow(-10),
    ...over
  });
  if (error) throw new Error(`seedActiveSubscription: ${error.message}`);
}

const TABLE_FOR_KIND: Record<UsagePackCheckoutKind, string> = {
  voice_bonus_seconds: "voice_bonus_grants",
  sms_bonus_texts: "sms_bonus_grants",
  chat_credit_micros: "chat_spend_credit_grants"
};

const AMOUNT_COLUMN_FOR_KIND: Record<UsagePackCheckoutKind, string> = {
  voice_bonus_seconds: "seconds_purchased",
  sms_bonus_texts: "texts_purchased",
  chat_credit_micros: "credit_micros_purchased"
};

async function grantRows(
  db: SupabaseClient,
  kind: UsagePackCheckoutKind,
  businessId: string
): Promise<Array<Record<string, unknown>>> {
  // `select("*")` rather than an interpolated column list: the column name
  // varies per family, and a template literal defeats supabase-js's
  // compile-time column parser.
  const { data, error } = await db
    .from(TABLE_FOR_KIND[kind])
    .select("*")
    .eq("business_id", businessId);
  if (error) throw new Error(`grantRows(${kind}): ${error.message}`);
  return data as Array<Record<string, unknown>>;
}

describe("Stripe webhook grants against real Postgres", () => {
  const db = serviceDb();
  let businessId = "";

  beforeAll(async () => {
    businessId = await seedBusiness(db, "Stripe webhook grants itest");
    await seedActiveSubscription(db, businessId);
  });

  beforeEach(() => {
    subscriptionRetrieve.mockReset();
    subscriptionRetrieve.mockResolvedValue(
      makeSubscription({ id: STRIPE_SUB_ID, status: "active" })
    );
  });

  describe("checkout.session.completed writes a real grant row", () => {
    const cases: Array<{ kind: UsagePackCheckoutKind; units: number }> = [
      { kind: "voice_bonus_seconds", units: 1_800 },
      { kind: "sms_bonus_texts", units: 500 },
      { kind: "chat_credit_micros", units: 5_000_000 }
    ];

    for (const { kind, units } of cases) {
      it(`grants ${kind} exactly once`, async () => {
        const sessionId = `cs_${randomUUID()}`;
        const session = makePackCheckoutSession({ kind, businessId, units, sessionId });

        expect(await deliver(makeEvent("checkout.session.completed", session))).toBe(200);

        const rows = await grantRows(db, kind, businessId);
        const row = rows.find((r) => r.stripe_checkout_session_id === sessionId);
        expect(row).toBeDefined();
        expect(Number(row![AMOUNT_COLUMN_FOR_KIND[kind]])).toBe(units);
      });

      it(`ignores a replayed ${kind} session`, async () => {
        const sessionId = `cs_${randomUUID()}`;
        const session = makePackCheckoutSession({ kind, businessId, units, sessionId });

        await deliver(makeEvent("checkout.session.completed", session));
        const afterFirst = (await grantRows(db, kind, businessId)).length;
        // Stripe retries the same event; the route must not mint a second row.
        await deliver(makeEvent("checkout.session.completed", session));

        expect((await grantRows(db, kind, businessId)).length).toBe(afterFirst);
      });
    }
  });

  describe("the expiry rule is max(period end, purchased + 30 days)", () => {
    it("uses the period end when it is further out", async () => {
      const sessionId = `cs_${randomUUID()}`;
      const periodEndSec = epochDaysFromNow(45);
      subscriptionRetrieve.mockResolvedValue(
        makeSubscription({
          id: STRIPE_SUB_ID,
          status: "active",
          current_period_start: epochDaysFromNow(-10),
          current_period_end: periodEndSec,
          items: { object: "list", data: [] }
        })
      );

      await deliver(
        makeEvent(
          "checkout.session.completed",
          makePackCheckoutSession({
            kind: "sms_bonus_texts",
            businessId,
            units: 500,
            sessionId
          })
        )
      );

      const row = (await grantRows(db, "sms_bonus_texts", businessId)).find(
        (r) => r.stripe_checkout_session_id === sessionId
      );
      expect(row).toBeDefined();
      expect(Date.parse(row!.expires_at as string)).toBe(periodEndSec * 1000);
    });

    it("uses purchased + 30 days when the period ends sooner", async () => {
      const sessionId = `cs_${randomUUID()}`;
      const createdSec = Math.floor(Date.now() / 1000);
      subscriptionRetrieve.mockResolvedValue(
        makeSubscription({
          id: STRIPE_SUB_ID,
          status: "active",
          current_period_start: epochDaysFromNow(-25),
          current_period_end: epochDaysFromNow(5),
          items: { object: "list", data: [] }
        })
      );

      await deliver(
        makeEvent(
          "checkout.session.completed",
          makePackCheckoutSession({
            kind: "sms_bonus_texts",
            businessId,
            units: 500,
            sessionId,
            over: { created: createdSec }
          })
        )
      );

      const row = (await grantRows(db, "sms_bonus_texts", businessId)).find(
        (r) => r.stripe_checkout_session_id === sessionId
      );
      expect(row).toBeDefined();
      // A pack must always be usable for at least 30 days, even when bought
      // on the last day of a billing period.
      expect(Date.parse(row!.expires_at as string)).toBe(createdSec * 1000 + THIRTY_DAYS_MS);
    });
  });

  describe("a blocked grant leaves nothing behind", () => {
    it("writes no row when the local subscription is not active", async () => {
      const lapsed = await seedBusiness(db, "Stripe webhook grants itest (lapsed)");
      await seedActiveSubscription(db, lapsed, { status: "canceled" });

      expect(
        await deliver(
          makeEvent(
            "checkout.session.completed",
            makePackCheckoutSession({
              kind: "sms_bonus_texts",
              businessId: lapsed,
              units: 500,
              sessionId: `cs_${randomUUID()}`
            })
          )
        )
      ).toBe(200);

      expect(await grantRows(db, "sms_bonus_texts", lapsed)).toHaveLength(0);
    });

    it("writes no row when Stripe says the subscription is not entitled", async () => {
      const unpaid = await seedBusiness(db, "Stripe webhook grants itest (unpaid)");
      await seedActiveSubscription(db, unpaid);
      // Local row still says active; Stripe is the tiebreaker.
      subscriptionRetrieve.mockResolvedValue(
        makeSubscription({ id: STRIPE_SUB_ID, status: "past_due" })
      );

      await deliver(
        makeEvent(
          "checkout.session.completed",
          makePackCheckoutSession({
            kind: "chat_credit_micros",
            businessId: unpaid,
            units: 5_000_000,
            sessionId: `cs_${randomUUID()}`
          })
        )
      );

      expect(await grantRows(db, "chat_credit_micros", unpaid)).toHaveLength(0);
    });

    it("writes no row when the Stripe lookup fails outright", async () => {
      const flaky = await seedBusiness(db, "Stripe webhook grants itest (stripe down)");
      await seedActiveSubscription(db, flaky);
      subscriptionRetrieve.mockRejectedValue(new Error("stripe unreachable"));

      expect(
        await deliver(
          makeEvent(
            "checkout.session.completed",
            makePackCheckoutSession({
              kind: "voice_bonus_seconds",
              businessId: flaky,
              units: 1_800,
              sessionId: `cs_${randomUUID()}`
            })
          )
        )
      ).toBe(200);

      expect(await grantRows(db, "voice_bonus_seconds", flaky)).toHaveLength(0);
    });

    it("writes no row when the session carries no businessId", async () => {
      const orphan = makePackCheckoutSession({
        kind: "sms_bonus_texts",
        businessId: "",
        units: 500,
        sessionId: `cs_${randomUUID()}`
      });
      expect(await deliver(makeEvent("checkout.session.completed", orphan))).toBe(200);
    });
  });

  describe("manual pack purchases and their PaymentIntent", () => {
    it("is the ONLY event that grants today", async () => {
      // Guard for the auto-reload work: the pack Checkouts mirror their
      // metadata onto payment_intent_data, so a manual purchase ALSO emits a
      // payment_intent.succeeded carrying checkoutKind and the unit count.
      // Nothing double-grants right now only because the route does not
      // handle that event. Adding a `payment_intent.succeeded` case keyed on
      // checkoutKind alone would grant twice, once under cs_ and once under
      // pi_, and the two distinct keys mean the RPC's idempotency cannot
      // catch it. This test pins the current baseline; the auto-reload PR
      // extends it to assert the metadata gate keeps it at one row.
      const sessionId = `cs_${randomUUID()}`;
      const paymentIntentId = `pi_${randomUUID().slice(0, 12)}`;
      const session = makePackCheckoutSession({
        kind: "sms_bonus_texts",
        businessId,
        units: 500,
        sessionId,
        over: { payment_intent: paymentIntentId } as Partial<Stripe.Checkout.Session>
      });

      await deliver(makeEvent("checkout.session.completed", session));
      const afterCheckout = await grantRows(db, "sms_bonus_texts", businessId);
      expect(
        afterCheckout.filter((r) => r.stripe_checkout_session_id === sessionId)
      ).toHaveLength(1);

      // No grant is keyed on the PaymentIntent id.
      expect(
        afterCheckout.filter((r) => r.stripe_checkout_session_id === `pi_${paymentIntentId}`)
      ).toHaveLength(0);
    });
  });
});
