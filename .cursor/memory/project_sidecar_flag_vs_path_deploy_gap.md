---
name: project_sidecar_flag_vs_path_deploy_gap
description: "A new vps/ sidecar MODE must be a new PATH, never a request flag: the app deploys on merge while boxes redeploy manually, and an old box ignores an unknown flag"
metadata: 
  node_type: memory
  type: project
  originSessionId: 867532b4-ab7d-4b45-90b3-d05274c76e2d
  modified: 2026-08-19T16:45:58.297Z
---

Aug 19 2026, building the browse-step dry run (PR #1510). The app ships to
Vercel the moment main is green; `vps/aiflow-render` only updates when someone
runs `tsx debug/redeploy-aiflow-render.ts --business-id <uuid>`, one tenant at
a time. So there is ALWAYS a window where the dashboard is new and a box is
old.

**An old box does not reject an unknown request field, it ignores it.** The
dry run was first built as `POST /render { actions, checkOnly: true }`. On a
box without that code, `checkOnly` is silently dropped and the existing
`if (actions)` branch runs `performActions`, so the button that promises to
change nothing would have clicked a live claim button on a real referral.

A flag cannot be made safe here: by the time the response shape reveals which
code answered, the actions have already run. A PATH can. `POST /check-actions`
returns 404 on an old box, which is a safe answer, and the app reports it as
"this business's browser service has not been updated yet" rather than as a
page that could not be opened.

Register the new route against the SAME handler rather than a copy
(`app.post("/render", renderHandler)` +
`app.post("/check-actions", (req,res) => { req.body = {...req.body, checkOnly:true}; return renderHandler(req,res); })`),
so page load, login and the SSRF guard cannot drift between modes, and FORCE
the mode in the wrapper so it is a property of the path.

Also worth copying: `debug/redeploy-aiflow-render.ts` greps the synced files
for markers of the new code and exits non-zero if they are missing, so a
partial rsync fails loudly instead of serving stale behavior.

Four tenants have live boxes (unrotated `vps_ssh_keys`): Amy
`621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`, KYP `056034a7-e84c-444d-8d15-747eeb1fa899`,
Scar Fairy `6cc2d7ba-a007-49d4-93a4-586967e147f1`, HQ
`8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d`. The context pack lists 9 tenants; the
other five have no box.

Related: [[project_fleet_redeploy_check]], [[project_foreach_cap_is_cloudflare_bound]].
