/**
 * Move a Facebook Page claim (page_id/page_name/page_token/IG fields) from
 * one business's meta_connections row to another's, without touching the
 * Meta-side subscription (an app<->page edge shared by whoever holds the
 * Page). The source row drops to `pending`/empty; the destination row goes
 * `active` with the moved fields. Run again with the arguments reversed to
 * move the claim back.
 *
 *   npx tsx debug/meta-claim-move.ts <fromBusinessId> <toBusinessId>
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const [fromBiz, toBiz] = process.argv.slice(2);
if (!fromBiz || !toBiz) {
  console.error("usage: npx tsx debug/meta-claim-move.ts <fromBusinessId> <toBusinessId>");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: src, error: srcErr } = await db
  .from("meta_connections")
  .select("*")
  .eq("business_id", fromBiz)
  .single();
if (srcErr || !src) throw new Error(`source row: ${srcErr?.message ?? "not found"}`);
if (!src.page_id || !src.page_token_encrypted) {
  throw new Error("source row holds no page claim to move");
}

const { data: dst, error: dstErr } = await db
  .from("meta_connections")
  .select("id")
  .eq("business_id", toBiz)
  .maybeSingle();
if (dstErr) throw new Error(`destination row: ${dstErr.message}`);

const moved = {
  status: "active" as const,
  page_id: src.page_id,
  page_name: src.page_name,
  page_token_encrypted: src.page_token_encrypted,
  account_name: src.account_name,
  instagram_account_id: src.instagram_account_id,
  instagram_username: src.instagram_username,
  is_active: true,
  updated_at: new Date().toISOString()
};

// 1. Release the claim on the source (unique index frees up).
{
  const { error } = await db
    .from("meta_connections")
    .update({
      status: "pending",
      page_id: null,
      page_name: null,
      page_token_encrypted: null,
      instagram_account_id: null,
      instagram_username: null,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", fromBiz);
  if (error) throw new Error(`release source claim: ${error.message}`);
}

// 2. Claim it on the destination (insert the row if the tenant never
//    connected). If this fails, restore the source row before exiting.
try {
  if (dst) {
    const { error } = await db.from("meta_connections").update(moved).eq("business_id", toBiz);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db
      .from("meta_connections")
      .insert({ business_id: toBiz, user_token_encrypted: null, ...moved });
    if (error) throw new Error(error.message);
  }
} catch (err) {
  const { error: restoreErr } = await db
    .from("meta_connections")
    .update({
      status: src.status,
      page_id: src.page_id,
      page_name: src.page_name,
      page_token_encrypted: src.page_token_encrypted,
      instagram_account_id: src.instagram_account_id,
      instagram_username: src.instagram_username,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", fromBiz);
  if (restoreErr) {
    console.error("RESTORE FAILED — source claim left released:", restoreErr.message);
  } else {
    console.error("destination claim failed — source claim restored");
  }
  throw err;
}

console.log(
  `moved page ${src.page_id} "${src.page_name}" (ig=${src.instagram_username ?? "-"}) ` +
    `from ${fromBiz} to ${toBiz}`
);
console.log(`to move back: npx tsx debug/meta-claim-move.ts ${toBiz} ${fromBiz}`);
