/**
 * hostinger-term-prices.ts — read-only: print every VPS catalog price entry
 * (all term lengths) for kvm1/kvm2/kvm4/kvm8 so we can compare monthly vs
 * 12/24-month term buying. No writes.
 *
 * Usage: npx tsx debug/hostinger-term-prices.ts
 */
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();
const hostinger = makeHostingerClient();

const catalog = await hostinger.listCatalog("VPS");
for (const item of catalog) {
  if (!/kvm(1|2|4|8)\b/i.test(item.name) && !/kvm(1|2|4|8)/i.test(item.id)) continue;
  console.log(`\n${item.name} (${item.id})`);
  for (const p of item.prices) {
    const months = p.period_unit === "year" ? p.period * 12 : p.period;
    const perMonth = p.price / months / 100;
    const firstPerMonth =
      p.first_period_price != null ? p.first_period_price / months / 100 : null;
    console.log(
      `  ${p.id}  ${p.period}${p.period_unit}  total $${(p.price / 100).toFixed(2)}` +
        `  => $${perMonth.toFixed(2)}/mo` +
        (firstPerMonth != null
          ? `  (first period: $${((p.first_period_price ?? 0) / 100).toFixed(2)} => $${firstPerMonth.toFixed(2)}/mo)`
          : "")
    );
  }
}
