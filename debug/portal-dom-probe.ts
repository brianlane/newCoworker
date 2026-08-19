#!/usr/bin/env tsx
/**
 * READ-ONLY DOM probe for a credentialed vendor portal page.
 *
 * Authoring a `browse_action` means naming real selectors: a button's visible
 * text, a `<select>`'s option labels, a textarea's `name`. Guessing them is how
 * `debug/update-amy-aiflow-re-update-actions.ts` came to exist: the first
 * ReferralExchange update sequence was written blind, the note field turned out
 * to be `textarea[name="message"]` rather than a placeholder, and the step
 * timed out on action 4 in production for weeks.
 *
 * This prints the page's real controls so the next sequence is written from
 * evidence instead. It renders through the tenant's own aiflow-render sidecar,
 * so it sees the page exactly as a flow would: same browser, same login, same
 * stored `custom_integrations` credentials.
 *
 * By default it CANNOT CLICK: the render service only performs actions when the
 * request carries an `actions` array, and none is sent unless you pass a click
 * flag. The only side effect of a plain read is the same login the tenant's
 * flows already perform many times a day.
 *
 * `--click` / `--click-selector` add NAVIGATIONAL clicks, for the case a list
 * row is an SPA anchor with no href (HomeLight's referral rows are exactly
 * that), so no URL reaches the detail view and reading it requires opening it.
 * `--fill` types into a SEARCH box, and only a search box: SPA lists like
 * HomeLight's reach a record by searching for it, so reading that record is
 * impossible without typing a name. It is not a general form filler. The
 * selector must look search-shaped (SEARCH_FIELD_RE), password fields are
 * refused outright, and there is still no submit flag: this tool navigates and
 * reads, it never completes a form. Targets matching DESTRUCTIVE_TARGETS are
 * refused too, so a typo cannot decline a live referral or accept one on the
 * tenant's behalf.
 *
 * Credentials are never handled here. The request carries an integration LABEL;
 * the render service resolves it to a secret itself through the platform
 * gateway. Nothing decrypted is printed or written to disk.
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/portal-dom-probe.ts --label "Clever" --url "https://..."
 *   tsx debug/portal-dom-probe.ts --label "HomeLight" --url "https://..." --text
 *   tsx debug/portal-dom-probe.ts --url "https://example.com/"   # no login
 *
 * Flags:
 *   --business-id <uuid>  tenant whose box and credentials to use
 *                         (default: Amy Laidlaw Real Estate)
 *   --label <string>      `custom_integrations.label`, EXACT. Amy's are
 *                         "Clever", "HomeLight", "Referral Exchange",
 *                         "Realtor.com". Omit for an unauthenticated render.
 *   --url <url>           page to read (required)
 *   --text                also print the page's visible text
 *   --links               print every link href, not just the first 40
 *   --grep <needle>       print visible-text lines containing this needle
 *   --raw <text>          print raw markup around each LITERAL match (case
 *                         insensitive). This is how you find a row's href when
 *                         the row is a div with a click handler rather than an
 *                         <a>, which is most SPA lists.
 *   --raw-before/-after/-limit  window size and match cap for --raw
 *   --click <text>        click a control by visible text (repeatable, ordered)
 *   --click-selector <css>  click by CSS selector (repeatable, ordered)
 *   --fill <css>=<value>  type into a SEARCH-shaped field (repeatable, ordered).
 *                         Refused on password fields and on anything whose
 *                         selector does not look like a search box.
 *   --expect <text>       wait for this visible text before reading. Use it
 *                         whenever a --click opens something that mounts
 *                         asynchronously (a drawer, a modal, a search overlay):
 *                         without it the read is a race and the thing you
 *                         clicked for may simply not be there yet.
 *   --shot <path>         save the post-action screenshot as JPEG and read it
 *
 * Clicks and reads report the page AFTER the actions, so a modal opened by a
 * click is what gets digested.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 *      SECRETS_ENCRYPTION_KEY, HOSTINGER_API_TOKEN.
 */
import { loadEnv } from "./_shared.ts";
import { getActiveVpsSshKeyForBusiness } from "../src/lib/db/vps-ssh-keys.ts";
import { stripCode, textOf } from "../src/lib/ai-flows/page-controls.ts";
import { sshExec } from "../src/lib/hostinger/ssh.ts";
import {
  ensureNextPublicSupabaseUrlOrExit,
  listTenantVpsTargets,
  requireServiceRoleAndHostingerToken,
  resolveTenantVpsPublicIp
} from "../scripts/lib/redeploy-tenant-vps.ts";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate

function fail(msg: string): never {
  console.error(`PROBE FAIL: ${msg}`);
  process.exit(1);
}

/**
 * Clicks that commit the tenant to something rather than merely navigating.
 * A probe has no business firing any of these, and on Amy's account a stray
 * "Decline referral" is a lost commission, so they are refused rather than
 * guarded behind a flag.
 */
const DESTRUCTIVE_TARGETS =
  /decline|claim|submit|accept|delete|remove|withdraw|send|pay|confirm|cancel|sign.?out|logout/i;

/**
 * `--fill` is allowed ONLY into something that looks like a search field.
 * Typing into an arbitrary input is how a read-only tool quietly becomes one
 * that edits a live record: the HomeLight detail view has a stage listbox and a
 * note box sitting inches from the search box.
 */
const SEARCH_FIELD_RE = /search|filter|query|typeahead|combobox/i;
/** Never type into a credential field, whatever the selector claims. */
const PASSWORD_FIELD_RE = /password|passwd|\bpwd\b/i;

function flags(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[++i]);
    else if (process.argv[i].startsWith(`--${name}=`)) out.push(process.argv[i].slice(name.length + 3));
  }
  return out;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

/**
 * The payload rides to the box base64-encoded, so a URL's `?`, `&` and `=`
 * cannot be reinterpreted by the remote shell. Same reasoning as the vault
 * sync shipping its script over stdin (PR #1267): never interpolate untrusted
 * text into a command line.
 */
function remoteRenderCommand(payloadJson: string): string {
  const b64 = Buffer.from(payloadJson, "utf8").toString("base64");
  return `set -euo pipefail
TOKEN="$(grep '^AIFLOW_RENDER_TOKEN=' /opt/aiflow-render/.env | cut -d= -f2-)"
echo '${b64}' | base64 -d > /tmp/probe-payload.json
curl -sf --max-time 120 -X POST http://127.0.0.1:8080/render \\
  -H "Content-Type: application/json" \\
  \${TOKEN:+-H "Authorization: Bearer \${TOKEN}"} \\
  --data-binary @/tmp/probe-payload.json
rm -f /tmp/probe-payload.json
`;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

function section(title: string, values: string[], limit = 60): void {
  console.log(`\n## ${title} (${values.length})`);
  if (values.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const v of values.slice(0, limit)) console.log(`  ${v}`);
  if (values.length > limit) console.log(`  ... ${values.length - limit} more`);
}

function reportControls(html: string): void {
  const body = stripCode(html);

  section(
    "Buttons (visible text)",
    uniq([...body.matchAll(/<button[^>]*>([\s\S]{0,300}?)<\/button>/gi)].map((m) => textOf(m[1])))
  );

  section(
    "Clickable roles (a/input/summary with a label)",
    uniq([
      ...[...body.matchAll(/<input[^>]*type="(submit|button)"[^>]*>/gi)].map((m) => {
        const value = /value="([^"]*)"/i.exec(m[0])?.[1] ?? "";
        return `input[type=${m[1]}] value="${value}"`;
      }),
      ...[...body.matchAll(/<summary[^>]*>([\s\S]{0,120}?)<\/summary>/gi)].map(
        (m) => `summary: ${textOf(m[1])}`
      )
    ])
  );

  // data-test is HomeLight's stable handle and the one the claim steps already
  // key on; the sc-* classes beside it are styled-components build hashes and
  // must never be used as selectors.
  section(
    "data-test / data-testid attributes",
    uniq([...body.matchAll(/data-test(?:id)?="([^"]+)"/gi)].map((m) => m[1]))
  );

  const selects = [...body.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/gi)];
  console.log(`\n## <select> elements (${selects.length})`);
  if (selects.length === 0) console.log("  (none)");
  for (const sel of selects) {
    const open = /<select[^>]*>/i.exec(sel[0])?.[0] ?? "";
    const id = /\sid="([^"]*)"/i.exec(open)?.[1] ?? "";
    const name = /\sname="([^"]*)"/i.exec(open)?.[1] ?? "";
    console.log(`  select id="${id}" name="${name}"`);
    for (const opt of sel[1].matchAll(/<option[^>]*>([\s\S]{0,120}?)<\/option>/gi)) {
      const value = /value="([^"]*)"/i.exec(opt[0])?.[1] ?? "";
      console.log(`      option value="${value}" label="${textOf(opt[1])}"`);
    }
  }

  section(
    "Inputs (placeholder / name / type)",
    uniq(
      [...body.matchAll(/<input[^>]*>/gi)].map((m) => {
        const type = /\stype="([^"]*)"/i.exec(m[0])?.[1] ?? "text";
        if (type === "password") return ""; // never echo a credential field's state
        const name = /\sname="([^"]*)"/i.exec(m[0])?.[1] ?? "";
        const ph = /\splaceholder="([^"]*)"/i.exec(m[0])?.[1] ?? "";
        return `input[type=${type}] name="${name}" placeholder="${ph}"`;
      })
    )
  );

  section(
    "Textareas (name / placeholder)",
    uniq(
      [...body.matchAll(/<textarea[^>]*>/gi)].map((m) => {
        const name = /\sname="([^"]*)"/i.exec(m[0])?.[1] ?? "";
        const ph = /\splaceholder="([^"]*)"/i.exec(m[0])?.[1] ?? "";
        return `textarea name="${name}" placeholder="${ph}"`;
      })
    )
  );

  section(
    "Headings",
    uniq([...body.matchAll(/<h[1-4][^>]*>([\s\S]{0,200}?)<\/h[1-4]>/gi)].map((m) => textOf(m[1])))
  );
}

function reportLinks(html: string, all: boolean): void {
  const body = stripCode(html);
  const rows = uniq(
    [...body.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi)]
      .filter((m) => !/^(#|mailto:|tel:|javascript:)/i.test(m[1]))
      .filter((m) => !/\.(css|js|png|jpe?g|svg|ico|woff2?)($|\?)/i.test(m[1]))
      .map((m) => {
        const label = textOf(m[2]);
        return label ? `${m[1]}   <- "${label.slice(0, 80)}"` : m[1];
      })
  );
  // These are how you get from a list page to one card: pick an href from here
  // and re-run the probe against it.
  section("Links (href <- visible text)", rows, all ? 500 : 40);
}

/**
 * Print what the page said about itself.
 *
 * The render service now returns console errors, uncaught page errors and
 * failed/4xx requests whenever a page had any, on success as well as failure.
 * Printing it here is the point of the whole exercise: "no matching control on
 * the page" and "the control never rendered because its data request was
 * blocked" are the same message without this, and telling them apart is what
 * stops the next person guessing at selectors.
 */
function reportDiagnostics(diagnostics?: Record<string, string[]>): void {
  if (!diagnostics) return;
  const entries = Object.entries(diagnostics).filter(([, v]) => Array.isArray(v) && v.length > 0);
  if (entries.length === 0) return;
  console.log(`\n## What the page reported about itself`);
  for (const [kind, items] of entries) {
    console.log(`  ${kind} (${items.length}):`);
    for (const item of items.slice(0, 8)) console.log(`    ${item}`);
    if (items.length > 8) console.log(`    ... ${items.length - 8} more`);
  }
  // blockedbyclient is OUR ssrf guard, not the portal failing. Say so rather
  // than let someone spend an afternoon blaming the vendor.
  if (JSON.stringify(entries).includes("blockedbyclient")) {
    console.log(`  note: "blockedbyclient" is OUR ssrf guard refusing that request, not the portal.`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  ensureNextPublicSupabaseUrlOrExit();
  const hostingerToken = requireServiceRoleAndHostingerToken();

  const businessId = flag("business-id") ?? DEFAULT_BUSINESS_ID;
  const label = flag("label");
  const url = flag("url");
  const grep = flag("grep");
  const wantText = process.argv.includes("--text");
  const allLinks = process.argv.includes("--links");
  if (!url) fail("--url is required");
  if (!/^https?:\/\//i.test(url)) fail(`--url must be http(s): ${url}`);

  const targets = await listTenantVpsTargets(businessId);
  if (targets.length === 0) fail(`no VPS for business ${businessId}`);
  const key = await getActiveVpsSshKeyForBusiness(businessId);
  if (!key) fail("no active ssh key");
  const ip = await resolveTenantVpsPublicIp(targets[0].hostingerVpsId, hostingerToken, "[probe]");
  if (!ip) fail("no public ip");

  // Ordered so `--click X --click-selector Y` runs X then Y, which is how you
  // walk a list row open and then read whatever it revealed.
  const actions: Array<{ kind: string; target: string; value?: string }> = [];
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--click" && process.argv[i + 1])
      actions.push({ kind: "click_text", target: process.argv[++i] });
    else if (a === "--click-selector" && process.argv[i + 1])
      actions.push({ kind: "click_selector", target: process.argv[++i] });
    else if (a === "--fill" && process.argv[i + 1]) {
      const raw = process.argv[++i];
      // LAST "=", not the first: CSS attribute selectors are full of them, so
      // splitting on the first turns `input[type="password"]=x` into the target
      // `input[type`, which sails past the credential guard on a technicality.
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
            `(selector must mention search/filter/query/typeahead/combobox). ` +
            `This tool reads records, it does not edit them.`
        );
      }
      actions.push({ kind: "fill_selector", target, value });
    }
  }
  for (const a of actions) {
    if (DESTRUCTIVE_TARGETS.test(a.target)) {
      fail(
        `refusing to click "${a.target}": it matches the destructive-target guard. ` +
          `This tool navigates and reads; it never commits an action on the tenant's behalf.`
      );
    }
  }
  const shotPath = flag("shot");
  /**
   * Wait for this text before reading. A client-rendered drawer or modal mounts
   * AFTER the click that opens it, so the probe's single read lands on whatever
   * happened to exist at that instant: HomeLight's referral drawer showed up in
   * one run's button list and was absent from the next run's markup, from the
   * same click. `expectText` makes the render service hold until the marker is
   * on the page, which turns a racy read into a deterministic one. The render
   * service rejects it alongside `forEachLink` or without actions, so it is only
   * meaningful with a --click.
   */
  const expectText = flag("expect");
  if (expectText && actions.length === 0) {
    console.error("--expect needs at least one --click / --click-selector / --fill to wait after.");
    process.exit(2);
  }

  // Without any click flag there is no `actions` key at all, so the render
  // service reads and returns and cannot interact with the page.
  const payload = JSON.stringify({
    url,
    businessId,
    ...(label ? { auth: { integrationLabel: label } } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(expectText ? { expectText } : {}),
    ...(shotPath ? { screenshot: true } : {})
  });

  console.log(`# Probe`);
  console.log(`business : ${businessId}`);
  console.log(`box      : ${targets[0].hostingerVpsId} (${ip})`);
  console.log(`label    : ${label ?? "(none, unauthenticated render)"}`);
  console.log(`url      : ${url}`);
  console.log(
    `actions  : ${actions.length === 0 ? "(none, read-only)" : actions.map((a) => `${a.kind}("${a.target}"${a.value === undefined ? "" : `="${a.value}"`})`).join(" -> ")}`
  );
  if (expectText) console.log(`expect   : "${expectText}" (waits for this before reading)`
  );

  const startedAt = Date.now();
  const ssh = await sshExec({
    host: ip,
    port: 22,
    username: key.ssh_username,
    privateKeyPem: key.private_key_pem,
    command: remoteRenderCommand(payload),
    timeoutMs: 180_000
  });
  const elapsedMs = Date.now() - startedAt;
  if (ssh.exitCode !== 0) fail(`render curl exit ${ssh.exitCode}: ${ssh.stderr.slice(-400)}`);

  let body: {
    finalUrl?: string;
    text?: string;
    html?: string;
    error?: string;
    detail?: string;
    actionsCompleted?: number;
    screenshotBase64?: string;
    pageTextExcerpt?: string;
    /** What the PAGE reported about itself (PR #1504). */
    diagnostics?: Record<string, string[]>;
  };
  try {
    body = JSON.parse(ssh.stdout);
  } catch {
    fail(`render returned non-JSON: ${ssh.stdout.slice(0, 300)}`);
  }
  // The render service reports application outcomes in a 200 body so a tunnel
  // cannot strip a structured error off a gateway status. Read `error` first.
  if (body.error) {
    // A login_failed now carries the page itself (PR #1419). Print it: the
    // whole point of those diagnostics is that a login failure is only
    // explicable by looking at what the page said back.
    if (body.finalUrl) console.log(`finalUrl : ${body.finalUrl}`);
    if (body.pageTextExcerpt) console.log(`\npage says:\n  ${body.pageTextExcerpt.replace(/\s+/g, " ").trim()}`);
    reportDiagnostics(body.diagnostics);
    const shotOut = flag("shot");
    if (shotOut && body.screenshotBase64) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(shotOut, Buffer.from(body.screenshotBase64, "base64"));
      console.log(`shot     : ${shotOut}`);
    }
    fail(`render error "${body.error}"${body.detail ? `: ${body.detail}` : ""}`);
  }

  const html = body.html ?? "";
  const text = body.text ?? "";
  console.log(`finalUrl : ${body.finalUrl ?? "(none)"}`);
  console.log(`elapsed  : ${(elapsedMs / 1000).toFixed(1)}s (includes ssh + login)`);
  console.log(`size     : ${html.length} chars html, ${text.length} chars text`);
  if (actions.length > 0) {
    console.log(`actions  : ${body.actionsCompleted ?? 0} of ${actions.length} completed`);
  }
  if (shotPath && body.screenshotBase64) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(shotPath, Buffer.from(body.screenshotBase64, "base64"));
    console.log(`shot     : ${shotPath}`);
  }
  if (!html) fail("render returned no html");

  // Success path too: a page whose data requests failed returns 200 with real
  // html and MISSING controls, which is exactly the case that reads as "this
  // portal has no such control".
  reportDiagnostics(body.diagnostics);
  reportControls(html);
  reportLinks(html, allLinks);

  if (grep) {
    const needle = grep.toLowerCase();
    const hits = uniq(
      textOf(stripCode(html))
        .split(/(?<=[.!?])\s+|\s{2,}/)
        .filter((line) => line.toLowerCase().includes(needle))
    );
    section(`Visible text containing "${grep}"`, hits, 40);
  }

  const raw = flag("raw");
  if (raw) {
    // Deliberately a LITERAL substring scan, not a regex built from argv.
    // Compiling a user-supplied pattern invites catastrophic backtracking, and
    // these pages run to half a megabyte, so one unlucky pattern hangs the
    // tool. Every real use of this flag has been a literal anyway: a
    // `data-test` value, a class name, a fragment of visible text.
    const before = Number(flag("raw-before") ?? 220);
    const after = Number(flag("raw-after") ?? 320);
    const limit = Number(flag("raw-limit") ?? 12);
    const needle = raw.toLowerCase();
    const haystack = html.toLowerCase();
    const hits: string[] = [];
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      hits.push(html.slice(Math.max(0, at - before), at + after).replace(/\s+/g, " "));
      if (hits.length >= limit) break;
    }
    section(`Raw markup around "${raw}"`, hits, limit);
  }

  if (wantText) {
    console.log(`\n## Visible text\n${text.slice(0, 8000)}`);
  }
}

main().catch((err) => {
  console.error(`PROBE FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
