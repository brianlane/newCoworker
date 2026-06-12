#!/usr/bin/env tsx
/**
 * One-off: inspect (and with --fix, true-up) Amy's chat-spend row for the
 * current billing period. Context: platform Gemini surfaces (AiFlow compile,
 * website ingest, knowledge lookups) were unmetered until PR #157, so the
 * meter showed $0.0076 while Google AI Studio billed $0.07 — all of it inside
 * the period that began 2026-05-29. `--fix` sets the row to the real amount.
 */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key);
const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const CORRECT_SPEND_MICROS = 70_000; // $0.07 per Google AI Studio spend page, 2026-06-12

const { data: sub } = await db
  .from("subscriptions")
  .select("stripe_current_period_start, stripe_current_period_end")
  .eq("business_id", BIZ)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log("subscription period:", JSON.stringify(sub));
const periodStart = sub?.stripe_current_period_start as string;

const { data: spend } = await db
  .from("owner_chat_model_spend")
  .select("period_start, spend_micros, fuse_tripped_at, updated_at")
  .eq("business_id", BIZ)
  .order("period_start", { ascending: false });
console.log("spend rows:", JSON.stringify(spend, null, 1));

if (process.argv.includes("--fix")) {
  const { data, error } = await db
    .from("owner_chat_model_spend")
    .update({ spend_micros: CORRECT_SPEND_MICROS, updated_at: new Date().toISOString() })
    .eq("business_id", BIZ)
    .eq("period_start", periodStart)
    .select("period_start, spend_micros");
  if (error) throw new Error(error.message);
  console.log("updated:", JSON.stringify(data));
}
