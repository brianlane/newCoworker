/**
 * The network guard for integration tests that run Node-side code in-process.
 *
 * These suites call real `src/lib` cores against the real local stack, which
 * means the code under test will happily try to send real email and real SMS.
 * This makes that structurally impossible rather than merely unlikely:
 *
 *   - localhost goes to the real stack, so the database half is genuinely
 *     integration-tested;
 *   - Resend and Telnyx are CAPTURED, so a test can assert on the message
 *     that would have been sent (the rendered subject, body, and HTML never
 *     reach the `notifications` row, so this is the only way to see them);
 *   - every other host THROWS, so a suite that starts reaching somewhere new
 *     fails loudly instead of quietly talking to it.
 *
 * Hosts are matched on the parsed hostname, never on a string prefix:
 * `https://api.resend.com.example.com` starts with `https://api.resend.com`,
 * and a guard that can be walked past with a suffix is not a guard.
 */

export type CapturedEmail = { to: string; subject: string; text: string; html: string };
export type CapturedSms = { to: string; text: string };

export type FetchGuard = {
  /** Emails the code under test tried to send, in order. */
  emails: CapturedEmail[];
  /** Texts the code under test tried to send, in order. */
  sms: CapturedSms[];
  /** Drop everything captured so far (call between scenarios). */
  reset(): void;
  /** Install the guard. Returns the restore function. */
  install(): () => void;
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  try {
    return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Deterministic stand-in id: these suites must not depend on randomness. */
function fakeId(prefix: string, n: number): string {
  return `itest-${prefix}-${n}`;
}

export function createFetchGuard(): FetchGuard {
  const emails: CapturedEmail[] = [];
  const sms: CapturedSms[] = [];

  return {
    emails,
    sms,
    reset() {
      emails.length = 0;
      sms.length = 0;
    },
    install() {
      const realFetch = globalThis.fetch;

      const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const host = hostnameOf(url);

        if (LOCAL_HOSTS.has(host)) return realFetch(input, init);

        if (host === "api.resend.com") {
          const body = bodyOf(init);
          emails.push({
            to: String(body.to ?? ""),
            subject: String(body.subject ?? ""),
            text: String(body.text ?? ""),
            html: String(body.html ?? "")
          });
          return new Response(
            JSON.stringify({ data: { id: fakeId("email", emails.length) }, error: null }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (host === "api.telnyx.com") {
          const body = bodyOf(init);
          sms.push({ to: String(body.to ?? ""), text: String(body.text ?? "") });
          return new Response(JSON.stringify({ data: { id: fakeId("sms", sms.length) } }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        throw new Error(`itest tried to reach an unexpected host: ${host || url}`);
      };

      globalThis.fetch = guarded as typeof fetch;
      return () => {
        globalThis.fetch = realFetch;
      };
    }
  };
}

/**
 * Point the code under test at the LOCAL stack, and refuse to run otherwise.
 *
 * Asserted rather than assumed: this process loads no `.env` today, but if
 * that ever changes these suites must fail to start rather than page real
 * business owners with test bookings.
 */
export function useLocalStackEnv(supabaseUrl: string): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  process.env.NEXT_PUBLIC_APP_URL = "https://ncw.example";
  process.env.RESEND_API_KEY = "itest-resend-key";

  const host = hostnameOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`refusing to run: Supabase URL is not local (${host || "unparseable"})`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("refusing to run: no service role key (set ITEST_SERVICE_ROLE_KEY)");
  }
}
