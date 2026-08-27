---
name: project_edge_functions_deploy_on_main
description: "Edge functions DO auto-deploy on main (inside the Vercel Deploy job), unlike vps/ which needs a manual redeploy"
metadata: 
  node_type: memory
  type: project
  originSessionId: dfdc2e1d-0b14-4961-9c0f-e3c288378b49
  modified: 2026-08-10T21:36:01.617Z
---

Checked 2026-08-10 before enabling a flag that depended on new edge-function
code. There is no separate deploy workflow file, which reads at first glance
like edge functions never ship automatically. They do:

The **`Vercel Deploy` job in `.github/workflows/ci.yml`** runs on every push to
main and does three things in order, each blocking the next:

1. `supabase db push` (applies pending migrations, fails loudly on ledger
   drift, never auto-repairs),
2. **bulk-deploys EVERY function in `supabase/functions/`** (verify_jwt pins
   read from the tracked `supabase/config.toml`, so a NEW function must get a
   `[functions.<name>] verify_jwt = false` entry there or it deploys wrong),
3. deploys the app to Vercel production.

So a merged edge-function change is live once the main run is green, and a
failed migration blocks the app deploy by design.

**The contrast that matters:** `vps/` is the opposite. A merged `vps/` change
is NOT live until a manual per-subtree redeploy, and the scripts are not
interchangeable (see [[project_fleet_redeploy_check]]).

**How to apply:** before turning on a tenant flag whose behavior lives in new
edge-function code, wait for the main run to go green rather than merging and
immediately applying the one-shot. Enabling first is not dangerous (the old
worker ignores an unknown step field) but the feature silently does nothing,
which reads as a bug. Related: [[project_main_run_watch_trap]].
