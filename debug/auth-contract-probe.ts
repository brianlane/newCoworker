/**
 * Does live Supabase Auth still honor the contracts the app is built on?
 *
 * The class of defect this exists for: a failing call INSIDE a third-party
 * SDK against a live service, which no unit test can see. The canonical case
 * is #1166: the project enabled Supabase's secure password change, the app
 * kept calling `updateUser({ password })` without `current_password`, every
 * suite stayed green, and NOBODY could change their password until Zapier's
 * app reviewer hit it. The next Supabase Auth setting change gets found by
 * this probe instead of by an external reviewer.
 *
 * Run it after ANY change in the Supabase dashboard under Authentication
 * (sign-in providers, secure password change, password requirements), and
 * whenever an auth-adjacent bug report smells like the server refusing a
 * call the app believes is valid.
 *
 * What it does, against the LIVE project: creates one throwaway user via the
 * admin API (random address at example.invalid, confirmed at creation so no
 * mail is ever sent; random passwords, never printed), exercises the
 * contracts below with the ANON key exactly as the browser does, and deletes
 * the user in a finally block. No tenant rows are touched; the user never
 * has a business, a membership, or a session cookie anywhere.
 *
 * Contracts probed:
 *   1. Password sign-in works for a confirmed user (the login page's whole
 *      auth path, LoginForm.tsx calls signInWithPassword client-side).
 *   2. `updateUser({ password })` WITHOUT current_password is REFUSED
 *      (secure password change is ON; if this ever passes, the setting was
 *      turned off and the reauth step in password-change.ts is the only
 *      thing standing between a hijacked session and a silent rotation).
 *   3. `updateUser({ password, current_password })` succeeds (the #1166
 *      contract, mirrored from src/lib/account/password-change.ts).
 *   4. The new password signs in; the old one no longer does.
 *   5. The server's minimum length matches PASSWORD_MIN_LENGTH in
 *      src/lib/password.ts. That file mirrors Supabase character for
 *      character so a password the form accepts can never be refused
 *      server-side; the CASA cycle proved the two can drift (server moved
 *      to 12 while the app said 8). GoTrue names the configured minimum in
 *      its rejection text, which is the only external read of the setting.
 *
 * Usage:
 *   tsx debug/auth-contract-probe.ts
 */
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { PASSWORD_MIN_LENGTH } from "../src/lib/password";
import { loadEnv } from "./_shared";

loadEnv();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!URL || !SERVICE_KEY || !ANON_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY"
  );
  process.exit(2);
}

/** Random password satisfying every rule in src/lib/password.ts. */
function randomPassword(length = PASSWORD_MIN_LENGTH + 4): string {
  return `Aa1!${randomBytes(length).toString("base64url").slice(0, length)}`;
}

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
}

async function main(): Promise<void> {
  const admin = createClient(URL!, SERVICE_KEY!, { auth: { persistSession: false } });
  // .invalid is reserved (RFC 2606): this address can never receive mail and
  // never collides with the @newcoworker.com catch-all worker.
  const email = `auth-contract-probe-${randomBytes(6).toString("hex")}@probe.invalid`;
  const password1 = randomPassword();
  const password2 = randomPassword();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: password1,
    email_confirm: true
  });
  if (createErr || !created?.user) {
    console.error(`Could not create the throwaway user: ${createErr?.message ?? "no user"}`);
    process.exit(2);
  }
  const userId = created.user.id;

  try {
    // The browser's client: anon key, real session.
    const client = createClient(URL!, ANON_KEY!, { auth: { persistSession: false } });

    // 1. Password sign-in.
    const { error: signInErr } = await client.auth.signInWithPassword({
      email,
      password: password1
    });
    record("password sign-in for a confirmed user", !signInErr, signInErr?.message ?? "");

    // 2. Update WITHOUT current_password must be refused.
    const { error: bareErr } = await client.auth.updateUser({ password: password2 });
    record(
      "updateUser without current_password is refused (secure password change ON)",
      Boolean(bareErr),
      bareErr ? bareErr.message : "server ACCEPTED a bare password update"
    );

    // 3. Update WITH current_password must succeed (the #1166 contract).
    const { error: withErr } = await client.auth.updateUser({
      password: password2,
      // The SDK types lag the GoTrue API here, exactly as in the app's own
      // password-change call.
      current_password: password1
    } as Parameters<typeof client.auth.updateUser>[0]);
    record("updateUser with current_password succeeds", !withErr, withErr?.message ?? "");

    // 4. New password works, old one does not.
    const fresh = createClient(URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { error: newErr } = await fresh.auth.signInWithPassword({
      email,
      password: password2
    });
    record("new password signs in", !newErr, newErr?.message ?? "");
    const { error: oldErr } = await fresh.auth.signInWithPassword({
      email,
      password: password1
    });
    record("old password no longer signs in", Boolean(oldErr), oldErr ? "" : "old still valid");

    // 5. Server minimum equals the app's PASSWORD_MIN_LENGTH. GoTrue names
    // the configured floor in its rejection: "Password should be at least N
    // characters." Probe with one char short of the app's constant: if the
    // server floor is lower, the update SUCCEEDS and the app is stricter
    // than the server (drift, but the safe direction); if it rejects naming
    // a different N, the two have drifted the dangerous way.
    const short = randomPassword(PASSWORD_MIN_LENGTH).slice(0, PASSWORD_MIN_LENGTH - 1);
    const { error: minErr } = await fresh.auth.updateUser({
      password: short,
      current_password: password2
    } as Parameters<typeof fresh.auth.updateUser>[0]);
    if (!minErr) {
      record(
        `server minimum matches PASSWORD_MIN_LENGTH=${PASSWORD_MIN_LENGTH}`,
        false,
        `server accepted ${PASSWORD_MIN_LENGTH - 1} chars: its floor is LOWER than the app's`
      );
    } else {
      const named = /at least (\d+)/.exec(minErr.message)?.[1];
      record(
        `server minimum matches PASSWORD_MIN_LENGTH=${PASSWORD_MIN_LENGTH}`,
        named === String(PASSWORD_MIN_LENGTH),
        named
          ? `server names ${named}`
          : `rejection did not name a minimum: ${minErr.message}`
      );
    }
  } finally {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) {
      console.error(
        `CLEANUP FAILED: throwaway auth user ${userId} (${email}) still exists, delete it by hand: ${delErr.message}`
      );
    } else {
      console.log(`cleaned up: throwaway user deleted (${userId})`);
    }
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} auth contracts hold` +
      (failed.length ? `; FAILED: ${failed.map((f) => f.name).join("; ")}` : "")
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
