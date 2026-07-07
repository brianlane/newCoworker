import { loadEnv, makeHostingerClient } from "./_shared.ts";
loadEnv();
const c = makeHostingerClient();
console.log(JSON.stringify(await c.listBillingSubscriptions(), null, 1));
