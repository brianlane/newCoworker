#!/usr/bin/env tsx
/** One-off: inspect Amy's chat-spend rows and billing period. */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key);
const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const { data: sub } = await db
  .from("subscriptions")
  .select("stripe_current_period_start, stripe_current_period_end, created_at")
  .eq("business_id", BIZ)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log("subscription period:", JSON.stringify(sub));

const { data: spend } = await db
  .from("owner_chat_model_spend")
  .select("period_start, spend_micros, fuse_tripped_at, updated_at")
  .eq("business_id", BIZ)
  .order("period_start", { ascending: false });
console.log("spend rows:", JSON.stringify(spend, null, 1));
