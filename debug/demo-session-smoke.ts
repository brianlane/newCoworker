#!/usr/bin/env tsx
/**
 * Engineer smoke for the render sidecar's DEMONSTRATION paths
 * (/demo/start, /demo/act, /demo/stop), before and without the dashboard UI.
 *
 * Drives one demo session end to end over SSH + loopback curl, the same
 * transport as debug/portal-dom-probe.ts, so it exercises the box exactly as
 * deployed (bearer, rate limit, tunnel-free loopback). Each turn prints what
 * was RECORDED, which is the point: a demonstration's output is a browse
 * action array the flow engine can replay.
 *
 * SAFETY, stricter than the dashboard on purpose: this is an engineer tool
 * with no owner sitting at it, so acts whose target or value matches
 * DESTRUCTIVE_TARGETS are refused outright rather than confirmed, --fill is
 * allowed only into search-shaped selectors and never password fields (both
 * rules verbatim from portal-dom-probe.ts), and --fill-point is refused
 * entirely on a credentialed session (the field under a point is unknown
 * until the sidecar resolves it, so the search-shape rule cannot be applied
 * first; use it against public test pages only).
 *
 * Usage:
 *   tsx debug/demo-session-smoke.ts --url "https://example.com/" \
 *     --click-point 100,80 --shot /tmp/demo.jpg
 *   tsx debug/demo-session-smoke.ts --label "Clever" --url "https://..." \
 *     --click "Offers"
 *   tsx debug/demo-session-smoke.ts --url "https://example.com/" --keep
 *   tsx debug/demo-session-smoke.ts --demo-id <uuid> --stop-only
 *
 * Flags:
 *   --business-id <uuid>   tenant whose box to use (default: Amy Laidlaw)
 *   --label <string>       custom_integrations.label for a credentialed start
 *   --url <url>            page to start the demo on (required unless --demo-id)
 *   --demo-id <uuid>       act on an existing session instead of starting one
 *                          (also how unknown_demo is smoked: pass a bogus id)
 *   --click <text>         demo act: click_text (repeatable, argv order)
 *   --click-selector <css> demo act: click_selector
 *   --fill <css>=<value>   demo act: fill_selector (search-shaped css only)
 *   --select <css>=<label> demo act: select_option
 *   --click-point <x,y>    demo act: click_point (document-space CSS px)
 *   --fill-point <x,y>=<v> demo act: fill_point (public pages only, see above)
 *   --shot <path>          save the LAST turn's screenshot as JPEG
 *   --keep                 do not stop the session at the end (prints demoId)
 *   --stop-only            just stop the --demo-id session
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 *      HOSTINGER_API_TOKEN.
 */
import { loadEnv } from "./_shared.ts";
import { getActiveVpsSshKeyForBusiness } from "../src/lib/db/vps-ssh-keys.ts";
import { sshExec } from "../src/lib/hostinger/ssh.ts";
import {
  ensureNextPublicSupabaseUrlOrExit,
  listTenantVpsTargets,
  requireServiceRoleAndHostingerToken,
  resolveTenantVpsPublicIp
} from "../scripts/lib/redeploy-tenant-vps.ts";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate

function fail(msg: string): never {
  console.error(`DEMO SMOKE FAIL: ${msg}`);
  process.exit(1);
}

// Verbatim from debug/portal-dom-probe.ts; the sidecar's CONFIRM_LABEL_RE is
// the same pattern behind a confirm, this tool refuses instead.
const DESTRUCTIVE_TARGETS =
  /decline|claim|submit|accept|delete|remove|withdraw|send|pay|confirm|cancel|sign.?out|logout/i;
const SEARCH_FIELD_RE = /search|filter|query|typeahead|combobox/i;
const PASSWORD_FIELD_RE = /password|passwd|\bpwd\b/i;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

type DemoActionInput =
  | { kind: string; target: string; value?: string }
  | { kind: "click_point" | "fill_point"; x: number; y: number; value?: string };

function parsePoint(raw: string): { x: number; y: number } {
  const m = /^(\d+)\s*,\s*(\d+)$/.exec(raw.trim());
  if (!m) fail(`expected <x,y>, got "${raw}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Ordered acts from argv, with the engineer-tool refusals applied. */
function parseActs(hasLabel: boolean): DemoActionInput[] {
  const acts: DemoActionInput[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--click" && process.argv[i + 1]) {
      acts.push({ kind: "click_text", target: process.argv[++i] });
    } else if (a === "--click-selector" && process.argv[i + 1]) {
      acts.push({ kind: "click_selector", target: process.argv[++i] });
    } else if (a === "--select" && process.argv[i + 1]) {
      const raw = process.argv[++i];
      const eq = raw.lastIndexOf("=");
      if (eq < 1) fail(`--select expects <css>=<option>, got "${raw}"`);
      acts.push({ kind: "select_option", target: raw.slice(0, eq), value: raw.slice(eq + 1) });
    } else if (a === "--fill" && process.argv[i + 1]) {
      const raw = process.argv[++i];
      // LAST "=", not the first: CSS attribute selectors are full of them.
      const eq = raw.lastIndexOf("=");
      if (eq < 1) fail(`--fill expects <css>=<value>, got "${raw}"`);
      const target = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      if (PASSWORD_FIELD_RE.test(target)) {
        fail(`refusing to fill "${target}": this tool never types into a credential field.`);
      }
      if (!SEARCH_FIELD_RE.test(target)) {
        fail(
          `refusing to fill "${target}": --fill is for search boxes only ` +
            `(selector must mention search/filter/query/typeahead/combobox).`
        );
      }
      acts.push({ kind: "fill_selector", target, value });
    } else if (a === "--click-point" && process.argv[i + 1]) {
      acts.push({ kind: "click_point", ...parsePoint(process.argv[++i]) });
    } else if (a === "--fill-point" && process.argv[i + 1]) {
      const raw = process.argv[++i];
      const eq = raw.lastIndexOf("=");
      if (eq < 1) fail(`--fill-point expects <x,y>=<value>, got "${raw}"`);
      if (hasLabel) {
        fail(
          `--fill-point is refused on a credentialed session: the field under a point ` +
            `is unknown until the sidecar resolves it, so the search-shape rule cannot ` +
            `be applied first. Use --fill with a search-shaped selector, or a public page.`
        );
      }
      acts.push({ kind: "fill_point", ...parsePoint(raw.slice(0, eq)), value: raw.slice(eq + 1) });
    }
  }
  for (const act of acts) {
    const target = "target" in act ? act.target : "";
    const value = act.value ?? "";
    if (DESTRUCTIVE_TARGETS.test(target) || DESTRUCTIVE_TARGETS.test(value)) {
      fail(
        `refusing act on "${target || value}": it matches the destructive-target guard. ` +
          `This tool never commits an action on the tenant's behalf; the dashboard's ` +
          `confirm flow is for owners.`
      );
    }
  }
  return acts;
}

/**
 * One loopback curl to a demo path, base64-shipped like portal-dom-probe so
 * the payload never meets the remote shell. Prints the HTTP status separately
 * because a 404 IS an answer here: it means the box predates the demo paths.
 */
function remoteDemoCommand(path: string, payloadJson: string): string {
  const b64 = Buffer.from(payloadJson, "utf8").toString("base64");
  return `set -euo pipefail
TOKEN="$(grep '^AIFLOW_RENDER_TOKEN=' /opt/aiflow-render/.env | cut -d= -f2-)"
echo '${b64}' | base64 -d > /tmp/demo-smoke-payload.json
STATUS=$(curl -s -o /tmp/demo-smoke-out.json -w '%{http_code}' --max-time 150 \\
  -X POST http://127.0.0.1:8080${path} \\
  -H "Content-Type: application/json" \\
  \${TOKEN:+-H "Authorization: Bearer \${TOKEN}"} \\
  --data-binary @/tmp/demo-smoke-payload.json)
echo "HTTP_STATUS:\${STATUS}"
cat /tmp/demo-smoke-out.json 2>/dev/null || true
rm -f /tmp/demo-smoke-payload.json /tmp/demo-smoke-out.json
`;
}

interface DemoResponseBody {
  demoId?: string;
  recorded?: { kind: string; target: string; value?: string };
  actionsCount?: number;
  finalUrl?: string;
  text?: string;
  html?: string;
  screenshotBase64?: string;
  loggedIn?: boolean;
  ok?: boolean;
  error?: string;
  reason?: string;
  detail?: string;
  options?: string[];
  label?: string;
  resolved?: { kind: string; target: string; value?: string };
  diagnostics?: Record<string, string[]>;
}

async function callDemo(
  ssh: { host: string; username: string; privateKeyPem: string },
  path: string,
  payload: unknown
): Promise<{ status: number; body: DemoResponseBody }> {
  const res = await sshExec({
    host: ssh.host,
    port: 22,
    username: ssh.username,
    privateKeyPem: ssh.privateKeyPem,
    command: remoteDemoCommand(path, JSON.stringify(payload)),
    timeoutMs: 200_000
  });
  if (res.exitCode !== 0) fail(`ssh/curl exit ${res.exitCode}: ${res.stderr.slice(-400)}`);
  const statusMatch = /HTTP_STATUS:(\d+)/.exec(res.stdout);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const jsonStart = res.stdout.indexOf("\n", res.stdout.indexOf("HTTP_STATUS:"));
  const raw = jsonStart >= 0 ? res.stdout.slice(jsonStart + 1).trim() : "";
  // A 404 is an ANSWER here, not a malformed one: the box predates the demo
  // paths, and Express replies with its own HTML error page. Say so before
  // trying to parse it, or the most likely first-run outcome greets an
  // engineer with a wall of markup instead of "redeploy this box".
  if (status === 404) {
    fail(
      "404 from the demo path: this box predates demonstration mode. " +
        "Redeploy it first: tsx debug/redeploy-aiflow-render.ts --business-id <uuid>"
    );
  }
  let body: DemoResponseBody = {};
  if (raw) {
    try {
      body = JSON.parse(raw) as DemoResponseBody;
    } catch {
      fail(`non-JSON demo response (status ${status}): ${raw.slice(0, 300)}`);
    }
  }
  return { status, body };
}

function printDiagnostics(diagnostics?: Record<string, string[]>): void {
  if (!diagnostics) return;
  for (const [kind, items] of Object.entries(diagnostics)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    console.log(`  diag ${kind} (${items.length}):`);
    for (const item of items.slice(0, 5)) console.log(`    ${item}`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  ensureNextPublicSupabaseUrlOrExit();
  const hostingerToken = requireServiceRoleAndHostingerToken();

  const businessId = flag("business-id") ?? DEFAULT_BUSINESS_ID;
  const label = flag("label");
  const url = flag("url");
  const existingDemoId = flag("demo-id");
  const shotPath = flag("shot");
  const keep = process.argv.includes("--keep");
  const stopOnly = process.argv.includes("--stop-only");
  if (!existingDemoId && !url) fail("--url is required (or pass --demo-id)");
  if (url && !/^https?:\/\//i.test(url)) fail(`--url must be http(s): ${url}`);
  const acts = parseActs(Boolean(label));

  const targets = await listTenantVpsTargets(businessId);
  if (targets.length === 0) fail(`no VPS for business ${businessId}`);
  const key = await getActiveVpsSshKeyForBusiness(businessId);
  if (!key) fail("no active ssh key");
  const ip = await resolveTenantVpsPublicIp(targets[0].hostingerVpsId, hostingerToken, "[demo-smoke]");
  if (!ip) fail("no public ip");
  const ssh = { host: ip, username: key.ssh_username || "root", privateKeyPem: key.private_key_pem };

  console.log(`# Demo smoke`);
  console.log(`business : ${businessId}`);
  console.log(`box      : ${targets[0].hostingerVpsId} (${ip})`);
  console.log(`label    : ${label ?? "(none, unauthenticated)"}`);

  let demoId = existingDemoId ?? "";
  let lastShot: string | undefined;

  if (stopOnly) {
    if (!demoId) fail("--stop-only requires --demo-id");
  } else if (!existingDemoId) {
    console.log(`\n== /demo/start ${url}`);
    const { body } = await callDemo(ssh, "/demo/start", {
      businessId,
      url,
      ...(label ? { auth: { integrationLabel: label } } : {})
    });
    if (body.error) fail(`start error "${body.error}"${body.detail ? `: ${body.detail}` : ""}`);
    if (!body.demoId) fail("start returned no demoId");
    demoId = body.demoId;
    lastShot = body.screenshotBase64 ?? lastShot;
    console.log(`demoId   : ${demoId}`);
    console.log(`finalUrl : ${body.finalUrl ?? "(none)"}`);
    console.log(`loggedIn : ${body.loggedIn === true}`);
    console.log(`size     : ${body.html?.length ?? 0} chars html, ${body.text?.length ?? 0} chars text`);
    printDiagnostics(body.diagnostics);
  }

  for (const act of acts) {
    const desc =
      "target" in act
        ? `${act.kind}("${act.target}"${act.value === undefined ? "" : `="${act.value}"`})`
        : `${act.kind}(${act.x},${act.y}${act.value ? `="${act.value}"` : ""})`;
    console.log(`\n== /demo/act ${desc}`);
    const { body } = await callDemo(ssh, "/demo/act", { businessId, demoId, action: act });
    lastShot = body.screenshotBase64 ?? lastShot;
    if (body.error === "needs_confirm") {
      // The engineer tool never confirms; reaching the gate is itself the
      // finding (the resolution worked and the guard held).
      console.log(
        `needs_confirm on "${body.label}" -> resolved ${body.resolved?.kind}("${body.resolved?.target}"). Not confirming.`
      );
      continue;
    }
    if (body.error) {
      console.log(
        `error    : ${body.error}${body.reason ? ` (${body.reason})` : ""}${body.detail ? `: ${body.detail}` : ""}`
      );
      if (body.options) console.log(`options  : ${body.options.join(" | ")}`);
      printDiagnostics(body.diagnostics);
      continue;
    }
    console.log(
      `recorded : ${body.recorded?.kind}("${body.recorded?.target}"${body.recorded?.value !== undefined ? `="${body.recorded.value}"` : ""})`
    );
    console.log(`count    : ${body.actionsCount}`);
    console.log(`finalUrl : ${body.finalUrl ?? "(none)"}`);
    printDiagnostics(body.diagnostics);
  }

  if (shotPath && lastShot) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(shotPath, Buffer.from(lastShot, "base64"));
    console.log(`\nshot     : ${shotPath}`);
  }

  if (keep) {
    console.log(`\n== keeping session open (demoId ${demoId}); stop it with --demo-id ${demoId} --stop-only`);
    return;
  }
  if (demoId) {
    console.log(`\n== /demo/stop`);
    const { body } = await callDemo(ssh, "/demo/stop", { businessId, demoId });
    console.log(`ok       : ${body.ok === true}${body.actionsCount !== undefined ? `, ${body.actionsCount} action(s) recorded` : ""}`);
  }
}

main().catch((err) => {
  console.error(`DEMO SMOKE FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
